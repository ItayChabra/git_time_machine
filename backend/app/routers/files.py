from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased, Session
import re
from ..database import SessionLocal
from .. import models, schemas
from ..episodes import episodes_for_file, file_story_for_file
from ..llm import explain_line_change

router = APIRouter()

# ── In-process hunk-level explanation cache ───────────────────────────────────
# Keyed by (repo_id, sha_prefix, file_path, hunk_start).
# Prevents multiple Gemini calls when the user hovers over different lines
# that fall inside the same diff hunk.
# Fine for local dev (single uvicorn process). For multi-worker deployments,
# replace with Redis or a shared cache layer.
_explanation_cache: dict[tuple, str] = {}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_hunk_for_line(patch: str, original_line: int) -> tuple[str, int | None, bool]:
    """
    Parse a unified diff and return the hunk that contains original_line.

    original_line is the line number in the file AT THE TIME OF THE COMMIT,
    as reported by `git blame --porcelain` (the second field on line 1).
    This is stable — it does not drift as the file changes after the commit.

    Returns (hunk_text, hunk_start, is_scoped) where:
      - hunk_start is the old-file start line from @@ -start,count @@
        (used as a stable cache key by the extension)
      - is_scoped=True means we found the exact hunk
      - is_scoped=False means we fell back to the full patch
    """
    if not patch or not original_line:
        return patch, None, False

    current_hunk_header: tuple[int, int] | None = None
    current_hunk_lines: list[str] = []
    hunks: list[tuple[int, int, list[str]]] = []  # (old_start, old_count, lines)

    for line in patch.split("\n"):
        m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        if m:
            if current_hunk_header is not None:
                hunks.append((current_hunk_header[0], current_hunk_header[1], current_hunk_lines))
            current_hunk_header = (int(m.group(1)), int(m.group(2) or 1))
            current_hunk_lines = [line]
        elif current_hunk_header is not None:
            current_hunk_lines.append(line)

    if current_hunk_header is not None:
        hunks.append((current_hunk_header[0], current_hunk_header[1], current_hunk_lines))

    for old_start, old_count, hunk_lines in hunks:
        if old_start <= original_line <= old_start + old_count:
            return "\n".join(hunk_lines), old_start, True

    # No hunk matched — return full patch with no stable hunk_start
    return patch, None, False


@router.get("/{repo_id}/list", response_model=list[schemas.FileEntry])
def list_files(repo_id: int, db: Session = Depends(get_db)):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    paths = (
        db.query(models.FileChange.file_path)
        .join(models.Commit)
        .filter(models.Commit.repo_id == repo_id)
        .distinct()
        .all()
    )
    return [schemas.FileEntry(path=p[0]) for p in paths]


@router.get("/{repo_id}/story", response_model=schemas.FileStory)
def get_file_story(repo_id: int, file_path: str = Query(...), db: Session = Depends(get_db)):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    ep_summaries = episodes_for_file(repo_id=repo_id, file_path=file_path, db=db)
    story = file_story_for_file(repo_id=repo_id, file_path=file_path, db=db)
    return schemas.FileStory(
        file_path=file_path,
        episodes=ep_summaries,
        file_story_summary=story,
    )


@router.get("/{repo_id}/blame_story", response_model=schemas.BlameStory)
def get_blame_story(
    repo_id: int,
    sha: str = Query(...),
    file_path: str = Query(None),
    original_line: int = Query(None),
    db: Session = Depends(get_db),
):
    """
    Core hover endpoint. Given a commit SHA, file path, and original line number
    (all from git blame --porcelain), returns a hunk-scoped explanation of why
    that specific code exists and whether it is safe to change.

    Returns hunk_start so the extension can cache at the hunk level — all lines
    in the same hunk share one explanation and one Gemini call.

    Precision hierarchy:
      1. Hunk-scoped (original_line + file_path + patch) — most specific
      2. File-scoped (file_path + patch, no line) — fallback
      3. Episode-level summary (no patch stored) — last resort
    """
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    commit = (
        db.query(models.Commit)
        .filter_by(repo_id=repo_id)
        .filter(models.Commit.sha.startswith(sha))
        .first()
    )
    if not commit:
        raise HTTPException(status_code=404, detail=f"Commit {sha} not found in repo")

    # ── File-scoped / hunk-scoped explanation ─────────────────────────────
    file_explanation: str | None = None
    hunk_start: int | None = None

    if file_path:
        file_change = (
            db.query(models.FileChange)
            .filter_by(commit_id=commit.id, file_path=file_path)
            .first()
        )

        if file_change and file_change.patch:
            pr = commit.pr

            if original_line:
                hunk, hunk_start, is_scoped = _extract_hunk_for_line(
                    file_change.patch, original_line
                )
            else:
                hunk, hunk_start, is_scoped = file_change.patch, None, False

            # Check in-process cache before calling Gemini.
            # Cache key uses hunk_start when available so all lines in the
            # same hunk share a single cached explanation.
            cache_key = (repo_id, sha[:8], file_path, hunk_start)
            if cache_key in _explanation_cache:
                file_explanation = _explanation_cache[cache_key]
            else:
                file_explanation = explain_line_change(
                    file_path=file_path,
                    hunk=hunk,
                    commit_message=commit.message or "",
                    pr_title=pr.title if pr else None,
                    pr_body=pr.body if pr else None,
                    is_hunk_scoped=is_scoped,
                )
                _explanation_cache[cache_key] = file_explanation

    # ── Episode (PR-level fallback context) ───────────────────────────────
    pr_member = aliased(models.EpisodeMember)
    issue_member = aliased(models.EpisodeMember)

    stmt = (
        select(
            models.Episode.id,
            models.Episode.title,
            models.Episode.start_date,
            models.Episode.end_date,
            models.Episode.llm_summary,
            models.PullRequest.number.label("pr_number"),
            models.Issue.number.label("issue_number"),
        )
        .join(
            models.EpisodeMember,
            and_(
                models.EpisodeMember.episode_id == models.Episode.id,
                models.EpisodeMember.commit_id == commit.id,
                models.EpisodeMember.member_type == "commit",
            ),
        )
        .outerjoin(
            pr_member,
            and_(
                pr_member.episode_id == models.Episode.id,
                pr_member.member_type == "pr",
            ),
        )
        .outerjoin(models.PullRequest, models.PullRequest.id == pr_member.pr_id)
        .outerjoin(
            issue_member,
            and_(
                issue_member.episode_id == models.Episode.id,
                issue_member.member_type == "issue",
            ),
        )
        .outerjoin(models.Issue, models.Issue.id == issue_member.issue_id)
        .limit(1)
    )

    row = db.execute(stmt).first()

    episode = None
    if row:
        episode = schemas.EpisodeSummary(
            id=row.id,
            title=row.title,
            start_date=row.start_date,
            end_date=row.end_date,
            llm_summary=row.llm_summary,
            pr_number=row.pr_number,
            issue_number=row.issue_number,
        )

    return schemas.BlameStory(
        sha=sha,
        file_path=file_path,
        hunk_start=hunk_start,
        file_explanation=file_explanation,
        episode=episode,
    )
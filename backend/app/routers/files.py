from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased, Session
import re
from ..database import SessionLocal
from .. import models, schemas
from ..episodes import episodes_for_file, file_story_for_file
from ..llm import explain_line_change

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_hunk_for_line(patch: str, original_line: int) -> tuple[str, bool]:
    """
    Parse a unified diff and return the hunk that contains original_line.

    original_line is the line number in the file AT THE TIME OF THE COMMIT,
    as reported by `git blame --porcelain` (the second field on line 1).
    This is stable — it does not drift as the file changes after the commit.

    Returns (hunk_text, is_scoped) where is_scoped=True means we found the
    exact hunk, False means we fell back to the full patch.
    """
    if not patch or not original_line:
        return patch, False

    current_hunk_header = None
    current_hunk_lines: list[str] = []
    # (old_start, old_count, hunk_lines)
    hunks: list[tuple[int, int, list[str]]] = []

    for line in patch.split("\n"):
        m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        if m:
            # Save previous hunk
            if current_hunk_header is not None:
                old_start = current_hunk_header[0]
                old_count = current_hunk_header[1]
                hunks.append((old_start, old_count, current_hunk_lines))
            current_hunk_header = (int(m.group(1)), int(m.group(2) or 1))
            current_hunk_lines = [line]
        elif current_hunk_header is not None:
            current_hunk_lines.append(line)

    # Save last hunk
    if current_hunk_header is not None:
        hunks.append((current_hunk_header[0], current_hunk_header[1], current_hunk_lines))

    # Find the hunk whose old-file range contains original_line
    for old_start, old_count, hunk_lines in hunks:
        if old_start <= original_line <= old_start + old_count:
            return "\n".join(hunk_lines), True

    # Fallback: no hunk matched, return full patch
    return patch, False


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
    original_line: int = Query(None),  # original line number from git blame --porcelain
    db: Session = Depends(get_db),
):
    """
    Core hover endpoint. Given a commit SHA, file path, and original line number
    (all from git blame --porcelain), returns a hunk-scoped explanation of why
    that specific code exists and whether it is safe to change.

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

    # ── Hunk or file-scoped patch explanation ─────────────────────────────
    file_explanation: str | None = None

    if file_path:
        file_change = (
            db.query(models.FileChange)
            .filter_by(commit_id=commit.id, file_path=file_path)
            .first()
        )

        if file_change and file_change.patch:
            pr = commit.pr

            if original_line:
                # Best case: extract just the hunk the developer is looking at
                hunk, is_scoped = _extract_hunk_for_line(file_change.patch, original_line)
            else:
                # No line info: use the full patch
                hunk, is_scoped = file_change.patch, False

            file_explanation = explain_line_change(
                file_path=file_path,
                hunk=hunk,
                commit_message=commit.message or "",
                pr_title=pr.title if pr else None,
                pr_body=pr.body if pr else None,
                is_hunk_scoped=is_scoped,
            )

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
        file_explanation=file_explanation,
        episode=episode,
    )
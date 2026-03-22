from fastapi import APIRouter, Depends, HTTPException, Query, Header
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased, Session
from typing import Annotated
import os
import re

from ..database import SessionLocal
from .. import models, schemas
from ..credentials import Credentials
from ..episodes import episodes_for_file, file_story_for_file
from ..llm import explain_function, explain_hunk

router = APIRouter()


# ── Persistent explanation cache ──────────────────────────────────────────────
# L1 in-process dict to avoid a DB round-trip on repeated hovers within the
# same server session. The authoritative store is the `explanations` table.

_mem_cache: dict[str, str] = {}


def _cache_get(key: str, db: Session) -> str | None:
    if key in _mem_cache:
        return _mem_cache[key]
    row = db.query(models.Explanation).filter_by(cache_key=key).first()
    if row:
        _mem_cache[key] = row.explanation
        return row.explanation
    return None


def _cache_set(key: str, value: str, db: Session) -> None:
    _mem_cache[key] = value
    if not db.query(models.Explanation).filter_by(cache_key=key).first():
        db.add(models.Explanation(cache_key=key, explanation=value))
        db.flush()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_credentials(
    x_github_token: Annotated[str | None, Header()] = None,
    x_gemini_api_key: Annotated[str | None, Header()] = None,
    x_gemini_model: Annotated[str | None, Header()] = None,
) -> Credentials:
    github_token = x_github_token or os.getenv("GITHUB_TOKEN", "")
    gemini_api_key = x_gemini_api_key or os.getenv("GEMINI_API_KEY", "")
    gemini_model = x_gemini_model or os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

    if not github_token:
        raise HTTPException(status_code=401, detail="GitHub token not provided")
    if not gemini_api_key:
        raise HTTPException(status_code=401, detail="Gemini API key not provided")

    return Credentials(
        github_token=github_token,
        gemini_api_key=gemini_api_key,
        gemini_model=gemini_model,
    )


def _extract_hunk_for_line(patch: str, original_line: int) -> tuple[str, int | None, int | None]:
    if not patch or not original_line:
        return patch, None, None

    current_header: tuple[int, int] | None = None
    current_lines: list[str] = []
    hunks: list[tuple[int, int, list[str]]] = []

    for line in patch.split("\n"):
        m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        if m:
            if current_header is not None:
                hunks.append((current_header[0], current_header[1], current_lines))
            current_header = (int(m.group(1)), int(m.group(2) or 1))
            current_lines = [line]
        elif current_header is not None:
            current_lines.append(line)

    if current_header is not None:
        hunks.append((current_header[0], current_header[1], current_lines))

    for old_start, old_count, hunk_lines in hunks:
        hunk_end = old_start + old_count
        if old_start <= original_line <= hunk_end:
            return "\n".join(hunk_lines), old_start, hunk_end

    return patch, None, None


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
def get_file_story(
    repo_id: int,
    file_path: str = Query(...),
    db: Session = Depends(get_db),
    creds: Credentials = Depends(get_credentials),
):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    ep_summaries = episodes_for_file(repo_id=repo_id, file_path=file_path, db=db)
    story = file_story_for_file(repo_id=repo_id, file_path=file_path, db=db, creds=creds)
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
    function_name: str = Query(None),
    db: Session = Depends(get_db),
    creds: Credentials = Depends(get_credentials),
):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    commit = (
        db.query(models.Commit)
        .filter_by(repo_id=repo_id)
        .filter(models.Commit.sha == sha)
        .first()
    )
    if not commit:
        raise HTTPException(status_code=404, detail=f"Commit {sha} not found in repo")

    file_explanation: str | None = None
    resolved_function_name: str | None = None

    if file_path:
        file_change = (
            db.query(models.FileChange)
            .filter_by(commit_id=commit.id, file_path=file_path)
            .first()
        )

        if file_change and file_change.patch:
            pr = commit.pr
            hunk, hunk_start, _ = _extract_hunk_for_line(
                file_change.patch, original_line or 1
            )

            if function_name and original_line:
                cache_key = f"fn:{sha}:{file_path}:{function_name}"
                file_explanation = _cache_get(cache_key, db)
                if file_explanation is None:
                    file_explanation = explain_function(
                        file_path=file_path,
                        function_name=function_name,
                        patch=hunk if hunk_start is not None else file_change.patch,
                        commit_message=commit.message or "",
                        pr_title=pr.title if pr else None,
                        pr_body=pr.body if pr else None,
                        api_key=creds.gemini_api_key,
                        model=creds.gemini_model,
                    )
                    _cache_set(cache_key, file_explanation, db)
                resolved_function_name = function_name

            elif original_line and hunk_start is not None:
                cache_key = f"hunk:{sha}:{file_path}:{hunk_start}"
                file_explanation = _cache_get(cache_key, db)
                if file_explanation is None:
                    file_explanation = explain_hunk(
                        file_path=file_path,
                        hunk=hunk,
                        commit_message=commit.message or "",
                        pr_title=pr.title if pr else None,
                        pr_body=pr.body if pr else None,
                        api_key=creds.gemini_api_key,
                        model=creds.gemini_model,
                    )
                    _cache_set(cache_key, file_explanation, db)

    # ── Episode fallback ──────────────────────────────────────────────────
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
        .join(models.EpisodeMember, and_(
            models.EpisodeMember.episode_id == models.Episode.id,
            models.EpisodeMember.commit_id == commit.id,
            models.EpisodeMember.member_type == "commit",
        ))
        .outerjoin(pr_member, and_(
            pr_member.episode_id == models.Episode.id,
            pr_member.member_type == "pr",
        ))
        .outerjoin(models.PullRequest, models.PullRequest.id == pr_member.pr_id)
        .outerjoin(issue_member, and_(
            issue_member.episode_id == models.Episode.id,
            issue_member.member_type == "issue",
        ))
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

    db.commit()

    return schemas.BlameStory(
        sha=sha,
        file_path=file_path,
        function_name=resolved_function_name,
        file_explanation=file_explanation,
        episode=episode,
    )
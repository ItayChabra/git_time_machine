from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased, Session
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
    file_path: str = Query(None),  # optional: enables file-scoped patch explanation
    db: Session = Depends(get_db),
):
    """
    Given a commit SHA (from git blame) and optionally a file path, return:
    - file_explanation: a file-scoped LLM answer about why those lines changed
      (only when file_path is provided and a patch is stored for that file)
    - episode: the PR-level episode as fallback context

    The VS Code extension sends both sha and file_path so the hover tooltip is
    specific to the file being viewed, not a generic PR summary.
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

    # ── File-scoped patch explanation ──────────────────────────────────────
    file_explanation: str | None = None

    if file_path:
        file_change = (
            db.query(models.FileChange)
            .filter_by(commit_id=commit.id, file_path=file_path)
            .first()
        )

        if file_change and file_change.patch:
            pr = commit.pr  # may be None for unlinked commits
            file_explanation = explain_line_change(
                file_path=file_path,
                patch=file_change.patch,
                commit_message=commit.message or "",
                pr_title=pr.title if pr else None,
                pr_body=pr.body if pr else None,
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
from __future__ import annotations

from datetime import timedelta
from typing import List

from sqlalchemy.orm import Session

from . import models, schemas


def _build_episode(
    window_commits: list[models.Commit],
    index: int,
    db: Session,
) -> schemas.EpisodeSummary:
    ep_start = window_commits[0].date
    ep_end = window_commits[-1].date
    title = f"Changes by {window_commits[0].author or 'unknown'} on {ep_start.date().isoformat()}"
    llm_summary = None

    # Pure DB lookup — zero API calls
    for commit in window_commits:
        if commit.pr_id is not None:
            pr = db.query(models.PullRequest).filter_by(id=commit.pr_id).first()
            if pr:
                title = f"PR #{pr.number}: {pr.title}"
                llm_summary = (pr.body[:200] + "...") if pr.body else None
                break

    return schemas.EpisodeSummary(
        id=index + 1,
        title=title,
        start_date=ep_start,
        end_date=ep_end,
        llm_summary=llm_summary,
    )


def episodes_for_file(repo_id: int, file_path: str, db: Session) -> List[schemas.EpisodeSummary]:
    """
    Build chronological EpisodeSummary list for a file within a repo.
    Windowing rule: commits within 1 day of each other belong to the same episode.
    All PR/issue context comes from the DB — no live API calls.
    """
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        return []

    commits = (
        db.query(models.Commit)
        .join(models.FileChange, models.FileChange.commit_id == models.Commit.id)
        .filter(
            models.Commit.repo_id == repo_id,
            models.FileChange.file_path == file_path,
            models.Commit.date.isnot(None),
        )
        .order_by(models.Commit.date.asc())
        .all()
    )

    # Deduplicate (join can produce multiple rows per commit if a file is touched multiple times)
    seen: set[int] = set()
    deduped: list[models.Commit] = []
    for c in commits:
        if c.id not in seen:
            seen.add(c.id)
            deduped.append(c)

    if not deduped:
        return []

    episodes: list[schemas.EpisodeSummary] = []
    window: list[models.Commit] = [deduped[0]]
    window_end = deduped[0].date

    for c in deduped[1:]:
        if c.date is None or c.date - window_end <= timedelta(days=1):
            window.append(c)
            if c.date:
                window_end = c.date
        else:
            episodes.append(_build_episode(window, len(episodes), db))
            window = [c]
            window_end = c.date

    episodes.append(_build_episode(window, len(episodes), db))
    return episodes

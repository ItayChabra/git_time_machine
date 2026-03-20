from __future__ import annotations

from datetime import timedelta
from typing import List
import re
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased
from sqlalchemy.orm import Session

from . import models, schemas
from .llm import summarize_episode, summarize_file_evolution


def _parse_issue_numbers(text: str) -> list[int]:
    return [int(m) for m in re.findall(r"#(\d+)", text or "")]


def _build_llm_context(window: list[models.Commit], pr: models.PullRequest | None, issue: models.Issue | None) -> dict:
    return {
        "pr_title": pr.title if pr else "",
        "pr_body": (pr.body[:600] if pr and pr.body else ""),
        "commit_messages": "\n".join(c.message or "" for c in window)[:600],
        "issue_title": issue.title if issue else "",
        "issue_body": (issue.body[:400] if issue and issue.body else ""),
    }


def build_and_persist_episodes(repo_id: int, db: Session) -> None:
    """
    Groups commits per file into episodes (by PR first, then time-windowed for raw commits), 
    calls LLM per episode, and persists Episode + EpisodeMember rows. 
    Safe to re-run (clears old rows first).
    """
    # Clear existing episodes for this repo
    old_eps = db.query(models.Episode).filter_by(repo_id=repo_id).all()
    for ep in old_eps:
        db.query(models.EpisodeMember).filter_by(episode_id=ep.id).delete()
        db.delete(ep)
    db.commit()

    # Fetch all commits for this repo ordered by date
    commits = (
        db.query(models.Commit)
        .filter_by(repo_id=repo_id)
        .filter(models.Commit.date.isnot(None))
        .order_by(models.Commit.date.asc())
        .all()
    )
    if not commits:
        return

    # --- NEW EPISODE GROUPING ---
    windows: list[list[models.Commit]] = []
    
    # Separate PR-linked commits from raw/unlinked commits
    commits_by_pr: dict[int, list[models.Commit]] = {}
    unlinked_commits: list[models.Commit] = []
    
    for c in commits:
        if c.pr_id is not None:
            commits_by_pr.setdefault(c.pr_id, []).append(c)
        else:
            unlinked_commits.append(c)

    # Add each PR as its own distinct isolated episode window
    for pr_id, pr_commits in commits_by_pr.items():
        windows.append(pr_commits)

    # Apply the 1-day temporal gap ONLY to unlinked, raw commits
    if unlinked_commits:
        window = [unlinked_commits[0]]
        window_end = unlinked_commits[0].date

        for c in unlinked_commits[1:]:
            if c.date - window_end <= timedelta(days=1):
                window.append(c)
                window_end = c.date
            else:
                windows.append(window)
                window = [c]
                window_end = c.date
        windows.append(window)

    # Sort all resulting windows chronologically by their first commit
    windows.sort(key=lambda w: w[0].date)

    for window_commits in windows:
        pr: models.PullRequest | None = None
        issue: models.Issue | None = None

        # (a) If any commit in the window is already linked to a PR, use that PR and skip further lookup.
        linked_commit = next((c for c in window_commits if c.pr_id is not None), None)
        if linked_commit is not None:
            pr = db.query(models.PullRequest).filter_by(id=linked_commit.pr_id).first()

        # (b) Otherwise, do a local DB heuristic to associate a PR to this episode's commits.
        if pr is None:
            # Heuristic window: "merged_at within 1 hour after commit date"
            # plus a slightly larger window to approximate PR creation time (since we don't store it).
            approx_hours_after_commit = 24

            for c in window_commits:
                # Only consider merged PRs.
                pr_match = (
                    db.query(models.PullRequest)
                    .filter_by(repo_id=repo_id)
                    .filter(models.PullRequest.merged_at.isnot(None))
                    .filter(models.PullRequest.merged_at >= c.date)
                    .filter(models.PullRequest.merged_at <= c.date + timedelta(hours=approx_hours_after_commit))
                    .order_by(models.PullRequest.merged_at.asc())
                    .first()
                )

                if pr_match is None:
                    continue

                # Cache association for future episodes.
                c.pr_id = pr_match.id
                db.flush()
                pr = pr_match
                break

        # Find linked issue via #number mentions
        all_text = " ".join([
            *(c.message or "" for c in window_commits),
            pr.title if pr else "",
            pr.body if pr and pr.body else "",
        ])
        issue_numbers = _parse_issue_numbers(all_text)
        if issue_numbers:
            issue = (
                db.query(models.Issue)
                .filter_by(repo_id=repo_id, number=issue_numbers[0])
                .first()
            )

        if pr:
            title = f"PR #{pr.number}: {pr.title or 'No Title'}"
        elif issue:
            title = f"Issue #{issue.number}: {issue.title or 'No Title'}"
        else:
            title = f"Changes on {window_commits[0].date.date().isoformat()}"

        context = _build_llm_context(window_commits, pr, issue)
        llm_summary = summarize_episode(context)

        ep = models.Episode(
            repo_id=repo_id,
            title=title,
            start_date=window_commits[0].date,
            end_date=window_commits[-1].date,
            llm_summary=llm_summary,
        )
        db.add(ep)
        db.flush()

        for c in window_commits:
            db.add(models.EpisodeMember(episode_id=ep.id, commit_id=c.id, member_type="commit"))
        if pr:
            db.add(models.EpisodeMember(episode_id=ep.id, pr_id=pr.id, member_type="pr"))
        if issue:
            db.add(models.EpisodeMember(episode_id=ep.id, issue_id=issue.id, member_type="issue"))

    db.commit()


def episodes_for_file(repo_id: int, file_path: str, db: Session) -> List[schemas.EpisodeSummary]:
    """
    Reads persisted episodes that touch the given file, returns them sorted by date.
    """
    commit_ids_for_file = (
        select(models.Commit.id)
        .join(models.FileChange, models.FileChange.commit_id == models.Commit.id)
        .where(
            models.Commit.repo_id == repo_id,
            models.FileChange.file_path == file_path,
        )
        .subquery()
    )

    episode_ids_for_file = (
        select(models.EpisodeMember.episode_id)
        .where(
            models.EpisodeMember.commit_id.in_(commit_ids_for_file),
            models.EpisodeMember.member_type == "commit",
        )
        .distinct()
    )

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
        .where(models.Episode.id.in_(episode_ids_for_file))
        .order_by(models.Episode.start_date.asc())
    )

    rows = db.execute(stmt).all()
    return [
        schemas.EpisodeSummary(
            id=row.id,
            title=row.title,
            start_date=row.start_date,
            end_date=row.end_date,
            llm_summary=row.llm_summary,
            pr_number=row.pr_number,
            issue_number=row.issue_number,
        )
        for row in rows
    ]


def file_story_for_file(repo_id: int, file_path: str, db: Session) -> str | None:
    """
    Build 1-2 sentence high-level story for a file based on chronological episode summaries.

    Returns None when there are no episodes, or when the Gemini call fails.
    """
    ep_summaries = episodes_for_file(repo_id=repo_id, file_path=file_path, db=db)
    chronological = [ep.llm_summary for ep in ep_summaries if ep.llm_summary]
    if not chronological:
        return None

    story = summarize_file_evolution(episodes_summaries=chronological)
    if not story:
        return None
    if story.startswith("File story failed:"):
        return None
    return story

from __future__ import annotations

import re
from datetime import timedelta
from typing import List

import requests
from sqlalchemy.orm import Session

from . import github_client, models, schemas


def episodes_for_file(repo_id: int, file_path: str, db: Session) -> List[schemas.EpisodeSummary]:
    """
    Build chronological EpisodeSummary list for a file within a repo.

    Windowing rule: commits whose timestamps are within 1 day of the previous commit
    belong to the same episode.
    """
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        return []

    gh = None
    try:
        gh = github_client.GitHubClient()
    except RuntimeError:
        # If GITHUB_TOKEN is not set, we can still compute episodes, just without PR context.
        gh = None

    commits = (
        db.query(models.Commit, models.FileChange)
        .join(models.FileChange, models.FileChange.commit_id == models.Commit.id)
        .filter(
            models.Commit.repo_id == repo_id,
            models.FileChange.file_path == file_path,
            models.Commit.date.isnot(None),
        )
        .order_by(models.Commit.date.asc())
        .all()
    )

    # De-duplicate in case the join returns multiple rows per commit for the same file.
    deduped_commits: list[models.Commit] = []
    seen_commit_ids: set[int] = set()
    for commit, _file_change in commits:
        if commit.id in seen_commit_ids:
            continue
        seen_commit_ids.add(commit.id)
        deduped_commits.append(commit)

    if not deduped_commits:
        return []

    episodes: list[tuple[list[models.Commit], schemas.EpisodeSummary]] = []

    window_commits: list[models.Commit] = []
    window_start = deduped_commits[0].date
    window_end = deduped_commits[0].date

    def build_title(author: str | None, date_value) -> str:
        author_str = author or "unknown"
        # date_value is guaranteed non-null by query filters.
        return f"Changes by {author_str} on {date_value.date().isoformat()}"

    def extract_pr_number_from_html_url(html_url: str | None) -> int | None:
        if not html_url:
            return None
        m = re.search(r"/pull/(\d+)", html_url)
        if not m:
            return None
        return int(m.group(1))

    def fetch_commit_html_url(sha: str) -> str | None:
        if gh is None:
            return None
        headers = gh._headers()
        try:
            resp = requests.get(
                f"{github_client.GITHUB_API_BASE}/repos/{repo.owner}/{repo.name}/commits/{sha}",
                headers=headers,
                timeout=30,
            )
            if resp.status_code != 200:
                return None
            return resp.json().get("html_url")
        except requests.RequestException:
            return None

    def fetch_pr(pr_number: int) -> dict | None:
        if gh is None:
            return None
        headers = gh._headers()
        try:
            resp = requests.get(
                f"{github_client.GITHUB_API_BASE}/repos/{repo.owner}/{repo.name}/pulls/{pr_number}",
                headers=headers,
                timeout=30,
            )
            if resp.status_code != 200:
                return None
            return resp.json()
        except requests.RequestException:
            return None

    window_commits.append(deduped_commits[0])

    for c in deduped_commits[1:]:
        if c.date is None or window_end is None:
            # If dates are missing, keep everything in the same window rather than splitting.
            window_commits.append(c)
            continue

        # If the new commit is within 1 day of the previous commit, keep it in the same episode.
        if c.date - window_end <= timedelta(days=1):
            window_commits.append(c)
            window_end = c.date
        else:
            # Finalize current episode summary.
            ep_start = window_start
            ep_end = window_end
            first = window_commits[0]
            title = build_title(first.author, ep_start)
            llm_summary = None
            if gh is not None:
                for commit in window_commits:
                    html_url = fetch_commit_html_url(commit.sha)
                    pr_number = extract_pr_number_from_html_url(html_url)
                    if not pr_number:
                        continue
                    pr_data = fetch_pr(pr_number)
                    if not pr_data:
                        continue
                    title = f"PR #{pr_data.get('number')}: {pr_data.get('title')}"
                    body = pr_data.get("body")
                    llm_summary = (body[:200] + "...") if body is not None else None
                    break

            episodes.append(
                (
                    window_commits,
                    schemas.EpisodeSummary(
                        id=len(episodes) + 1,
                        title=title,
                        start_date=ep_start,
                        end_date=ep_end,
                        llm_summary=llm_summary,
                    ),
                )
            )

            # Start a new episode window.
            window_commits = [c]
            window_start = c.date
            window_end = c.date

    # Finalize the last episode.
    ep_start = window_start
    ep_end = window_end
    first = window_commits[0]
    title = build_title(first.author, ep_start)
    llm_summary = None
    if gh is not None:
        for commit in window_commits:
            html_url = fetch_commit_html_url(commit.sha)
            pr_number = extract_pr_number_from_html_url(html_url)
            if not pr_number:
                continue
            pr_data = fetch_pr(pr_number)
            if not pr_data:
                continue
            title = f"PR #{pr_data.get('number')}: {pr_data.get('title')}"
            body = pr_data.get("body")
            llm_summary = (body[:200] + "...") if body is not None else None
            break

    episodes.append(
        (
            window_commits,
            schemas.EpisodeSummary(
                id=len(episodes) + 1,
                title=title,
                start_date=ep_start,
                end_date=ep_end,
                llm_summary=llm_summary,
            ),
        )
    )

    return [ep_summary for _window, ep_summary in episodes]

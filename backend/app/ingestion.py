import logging
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import bisect

from sqlalchemy.orm import Session

from . import github_client, models
from .database import SessionLocal
from .episodes import build_and_persist_episodes
from .models import RepoStatus

logger = logging.getLogger(__name__)


def _heuristic_link_commits(
    db: Session, repo_id: int, sha_to_commit_obj: dict
) -> None:
    """
    Pre-linking step: for any commit still missing pr_id, attempt to associate
    it with a PR by looking for the earliest merged PR within 24 hours after
    the commit date. Runs in ingestion so episodes.py can trust pr_id.

    Fix: preload all merged PRs once (O(1) query) then use bisect for O(log N)
    per-commit lookup instead of one DB query per commit (N+1).
    """
    # Load all merged PRs for this repo sorted by merged_at — one query total.
    merged_prs = (
        db.query(models.PullRequest)
        .filter_by(repo_id=repo_id)
        .filter(models.PullRequest.merged_at.isnot(None))
        .order_by(models.PullRequest.merged_at.asc())
        .all()
    )
    if not merged_prs:
        return

    merged_times = [pr.merged_at for pr in merged_prs]

    for sha, commit_obj in sha_to_commit_obj.items():
        if commit_obj.pr_id is not None:
            continue
        if commit_obj.date is None:
            continue

        lo = bisect.bisect_left(merged_times, commit_obj.date)
        hi = bisect.bisect_right(merged_times, commit_obj.date + timedelta(hours=24))
        candidates = merged_prs[lo:hi]
        if candidates:
            commit_obj.pr_id = candidates[0].id

    db.flush()


def ingest_repo_commits(repo_id: int, max_commits: int = 20) -> None:
    db = SessionLocal()
    target_repo = None
    try:
        target_repo = db.query(models.Repo).filter_by(id=repo_id).first()
        if not target_repo:
            return

        gh = github_client.GitHubClient()

        # ── 1. Fetch commit list ───────────────────────────────────────────
        per_page = min(100, max_commits) if max_commits > 0 else 20
        max_pages = math.ceil(max_commits / per_page) if max_commits > 0 else 1

        raw_commits = gh.list_commits(
            target_repo.owner, target_repo.name,
            per_page=per_page, max_pages=max_pages,
        )
        raw_commits = raw_commits[:max_commits] if max_commits > 0 else raw_commits

        sha_to_commit_obj: dict[str, models.Commit] = {}

        # Collect SHAs that need file fetching (skip already-ingested commits)
        commits_needing_files: list[tuple] = []  # (sha, raw_commit_dict)

        for c in raw_commits:
            commit_date = c.get("commit", {}).get("author", {}).get("date")
            if not commit_date:
                continue

            existing_commit = db.query(models.Commit).filter_by(sha=c["sha"]).first()
            if existing_commit:
                sha_to_commit_obj[c["sha"]] = existing_commit
                continue

            commit_obj = models.Commit(
                repo_id=target_repo.id,
                sha=c["sha"],
                author=(c.get("commit", {}).get("author", {}) or {}).get("name"),
                date=datetime.fromisoformat(commit_date.replace("Z", "+00:00")),
                message=c["commit"]["message"],
                pr_id=None,
            )
            db.add(commit_obj)
            db.flush()

            sha_to_commit_obj[c["sha"]] = commit_obj
            commits_needing_files.append((c["sha"], commit_obj))

        # ── 2. Fetch file changes in parallel ─────────────────────────────
        # Use a thread pool so we don't make N sequential HTTP calls.
        # GitHub throttles heavy sequential usage; parallel bursts are
        # handled better and stay within rate limits for typical batch sizes.
        owner, name = target_repo.owner, target_repo.name

        def _fetch_files(sha: str):
            return sha, gh.list_commit_files(owner, name, sha)

        max_workers = min(3, len(commits_needing_files)) if commits_needing_files else 1

        if commits_needing_files:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(_fetch_files, sha): commit_obj
                    for sha, commit_obj in commits_needing_files
                }
                for future in as_completed(futures):
                    commit_obj = futures[future]
                    try:
                        sha, files = future.result()
                        for f in files:
                            db.add(models.FileChange(
                                commit_id=commit_obj.id,
                                file_path=f["filename"],
                                change_type=f.get("status", "modified"),
                                patch=f.get("patch"),
                            ))
                    except Exception:
                        logger.exception(
                            "Failed to fetch files for commit",
                            extra={"repo_id": repo_id, "commit_id": commit_obj.id},
                        )

        # ── 3. Ingest PRs ─────────────────────────────────────────────────
        existing_pr_numbers = {
            n[0] for n in db.query(models.PullRequest.number)
            .filter_by(repo_id=target_repo.id).all()
        }

        def parse_dt(dt_str: str | None):
            if not dt_str:
                return None
            return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))

        raw_prs = gh.list_pulls(
            target_repo.owner, target_repo.name,
            state="all", per_page=20, max_pages=1,
        )

        pr_number_to_obj: dict[int, models.PullRequest] = {}

        for pr in raw_prs:
            pr_number = pr.get("number")
            if pr_number is None or pr_number in existing_pr_numbers:
                continue

            pr_obj = models.PullRequest(
                repo_id=target_repo.id,
                number=pr_number,
                title=pr.get("title"),
                body=pr.get("body"),
                state=pr.get("state"),
                merged_at=parse_dt(pr.get("merged_at")),
            )
            db.add(pr_obj)
            db.flush()
            pr_number_to_obj[pr_number] = pr_obj
            existing_pr_numbers.add(pr_number)

        # ── 4. Link commits → PRs via PR commits API ──────────────────────
        for pr_number, pr_obj in pr_number_to_obj.items():
            pr_commit_shas = gh.list_pr_commit_shas(
                target_repo.owner, target_repo.name, pr_number
            )
            for sha in pr_commit_shas:
                commit_obj = sha_to_commit_obj.get(sha)
                if commit_obj and commit_obj.pr_id is None:
                    commit_obj.pr_id = pr_obj.id

        # ── 5. Heuristic pre-linking for commits still missing pr_id ──────
        _heuristic_link_commits(
            db=db, repo_id=target_repo.id, sha_to_commit_obj=sha_to_commit_obj
        )

        # ── 6. Ingest issues ──────────────────────────────────────────────
        existing_issue_numbers = {
            n[0] for n in db.query(models.Issue.number)
            .filter_by(repo_id=target_repo.id).all()
        }

        raw_issues = gh.list_issues(
            target_repo.owner, target_repo.name,
            state="all", per_page=20, max_pages=1,
        )

        for issue in raw_issues:
            if issue.get("pull_request") is not None:
                continue
            issue_number = issue.get("number")
            if issue_number is None or issue_number in existing_issue_numbers:
                continue

            db.add(models.Issue(
                repo_id=target_repo.id,
                number=issue_number,
                title=issue.get("title"),
                body=issue.get("body"),
                state=issue.get("state"),
            ))
            db.flush()
            existing_issue_numbers.add(issue_number)

        build_and_persist_episodes(repo_id=target_repo.id, db=db)
        target_repo.status = RepoStatus.ready
        db.commit()

    except Exception:
        logger.exception(
            "Ingestion failed",
            extra={"repo_id": repo_id, "step": "ingest_repo_commits"},
        )
        db.rollback()
        if target_repo:
            target_repo.status = RepoStatus.error
            db.commit()
        raise
    finally:
        db.close()
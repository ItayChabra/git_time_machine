from sqlalchemy.orm import Session
from datetime import datetime
import math
import traceback

from . import github_client, models
from .database import SessionLocal
from .episodes import build_and_persist_episodes

def ingest_repo_commits(repo_id: int, max_commits: int = 20) -> None:
    """
    Background job: create its own DB session, ingest commits + file changes,
    and update repo.status to "ready" or "error".
    """
    db = SessionLocal()
    try:
        target_repo = db.query(models.Repo).filter_by(id=repo_id).first()
        if not target_repo:
            return

        gh = github_client.GitHubClient()

        per_page = min(100, max_commits) if max_commits > 0 else 20
        max_pages = math.ceil(max_commits / per_page) if max_commits > 0 else 1

        commits = gh.list_commits(
            target_repo.owner,
            target_repo.name,
            per_page=per_page,
            max_pages=max_pages,
        )
        commits = commits[:max_commits] if max_commits > 0 else commits

        for c in commits:
            commit_author_date = (
                c.get("commit", {})
                .get("author", {})
                .get("date", None)
            )
            if not commit_author_date:
                continue

            commit_obj = models.Commit(
                repo_id=target_repo.id,
                sha=c["sha"],
                author=(c.get("commit", {}).get("author", {}) or {}).get("name"),
                date=datetime.fromisoformat(commit_author_date.replace("Z", "+00:00")),
                message=c["commit"]["message"],
            )
            db.add(commit_obj)
            db.flush()

            files = gh.list_commit_files(target_repo.owner, target_repo.name, c["sha"])
            for f in files:
                db.add(
                    models.FileChange(
                        commit_id=commit_obj.id,
                        file_path=f["filename"],
                        change_type=f.get("status", "modified"),
                    )
                )

        # MVP speed bounds: keep PRs/issues ingestion small.
        max_prs = 20
        max_issues = 20

        existing_pr_numbers = {
            n[0] for n in db.query(models.PullRequest.number).filter_by(repo_id=target_repo.id).all()
        }
        existing_issue_numbers = {
            n[0] for n in db.query(models.Issue.number).filter_by(repo_id=target_repo.id).all()
        }

        def parse_github_dt(dt_str: str | None):
            if not dt_str:
                return None
            return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))

        prs = gh.list_pulls(
            target_repo.owner,
            target_repo.name,
            state="all",
            per_page=max_prs,
            max_pages=1,
        )
        for pr in prs:
            pr_number = pr.get("number")
            if pr_number is None or pr_number in existing_pr_numbers:
                continue

            db.add(
                models.PullRequest(
                    repo_id=target_repo.id,
                    number=pr_number,
                    title=pr.get("title"),
                    body=pr.get("body"),
                    state=pr.get("state"),
                    merged_at=parse_github_dt(pr.get("merged_at")),
                )
            )
            existing_pr_numbers.add(pr_number)

        issues = gh.list_issues(
            target_repo.owner,
            target_repo.name,
            state="all",
            per_page=max_issues,
            max_pages=1,
        )
        for issue in issues:
            # The issues endpoint includes PRs; skip those.
            if issue.get("pull_request") is not None:
                continue

            issue_number = issue.get("number")
            if issue_number is None or issue_number in existing_issue_numbers:
                continue

            db.add(
                models.Issue(
                    repo_id=target_repo.id,
                    number=issue_number,
                    title=issue.get("title"),
                    body=issue.get("body"),
                    state=issue.get("state"),
                )
            )
            existing_issue_numbers.add(issue_number)
        
        build_and_persist_episodes(repo_id=target_repo.id, db=db)
        target_repo.status = "ready"
        db.commit()
    except Exception:
        traceback.print_exc()
        db.rollback()
        if target_repo:
            target_repo.status = "error"
            db.commit()
        raise
    finally:
        db.close()

from sqlalchemy.orm import Session
from datetime import datetime
import math
<<<<<<< HEAD
import traceback

from . import github_client, models
from .database import SessionLocal
from .episodes import build_and_persist_episodes
=======
import re

from . import github_client, models
from .database import SessionLocal

ISSUE_REF_RE = re.compile(r"#(\d+)")

def extract_issue_numbers(text: str | None) -> list[int]:
    if not text:
        return []
    return [int(m) for m in ISSUE_REF_RE.findall(text)]

>>>>>>> git_time_machine/main

def ingest_repo_commits(repo_id: int, max_commits: int = 20) -> None:
    db = SessionLocal()
    try:
        target_repo = db.query(models.Repo).filter_by(id=repo_id).first()
        if not target_repo:
            return

        gh = github_client.GitHubClient()

        # ── 1. Ingest commits + file changes ──────────────────────────────
        per_page = min(100, max_commits) if max_commits > 0 else 20
        max_pages = math.ceil(max_commits / per_page) if max_commits > 0 else 1

        raw_commits = gh.list_commits(
            target_repo.owner, target_repo.name,
            per_page=per_page, max_pages=max_pages,
        )
        raw_commits = raw_commits[:max_commits] if max_commits > 0 else raw_commits

        sha_to_commit_obj: dict[str, models.Commit] = {}

        for c in raw_commits:
            commit_date = c.get("commit", {}).get("author", {}).get("date")
            if not commit_date:
                continue

            commit_obj = models.Commit(
                repo_id=target_repo.id,
                sha=c["sha"],
                author=(c.get("commit", {}).get("author", {}) or {}).get("name"),
                date=datetime.fromisoformat(commit_date.replace("Z", "+00:00")),
                message=c["commit"]["message"],
                pr_id=None,  # filled in step 3
            )
            db.add(commit_obj)
            db.flush()

            sha_to_commit_obj[c["sha"]] = commit_obj

            files = gh.list_commit_files(target_repo.owner, target_repo.name, c["sha"])
            for f in files:
                db.add(models.FileChange(
                    commit_id=commit_obj.id,
                    file_path=f["filename"],
                    change_type=f.get("status", "modified"),
                ))

        # ── 2. Ingest PRs ─────────────────────────────────────────────────
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

        # ── 3. Link commits → PRs via PR commits API ──────────────────────
        # One API call per PR (not per commit!) — O(PRs) not O(commits)
        for pr_number, pr_obj in pr_number_to_obj.items():
            pr_commit_shas = gh.list_pr_commit_shas(
                target_repo.owner, target_repo.name, pr_number
            )
            for sha in pr_commit_shas:
                commit_obj = sha_to_commit_obj.get(sha)
                if commit_obj and commit_obj.pr_id is None:
                    commit_obj.pr_id = pr_obj.id

        # ── 4. Ingest issues ──────────────────────────────────────────────
        existing_issue_numbers = {
            n[0] for n in db.query(models.Issue.number)
            .filter_by(repo_id=target_repo.id).all()
        }

        raw_issues = gh.list_issues(
            target_repo.owner, target_repo.name,
            state="all", per_page=20, max_pages=1,
        )

        issue_number_to_obj: dict[int, models.Issue] = {}

        for issue in raw_issues:
            if issue.get("pull_request") is not None:
                continue
            issue_number = issue.get("number")
            if issue_number is None or issue_number in existing_issue_numbers:
                continue

            issue_obj = models.Issue(
                repo_id=target_repo.id,
                number=issue_number,
                title=issue.get("title"),
                body=issue.get("body"),
                state=issue.get("state"),
            )
            db.add(issue_obj)
            db.flush()
            issue_number_to_obj[issue_number] = issue_obj
            existing_issue_numbers.add(issue_number)
<<<<<<< HEAD
        
        build_and_persist_episodes(repo_id=target_repo.id, db=db)
=======

        # ── 5. Link commits/PRs → issues via #123 references ─────────────
        all_issue_objs = {
            **issue_number_to_obj,
            **{
                n: obj for n, obj in (
                    (i.number, i)
                    for i in db.query(models.Issue).filter_by(repo_id=target_repo.id).all()
                )
            }
        }

        for commit_obj in sha_to_commit_obj.values():
            for issue_num in extract_issue_numbers(commit_obj.message):
                issue_obj = all_issue_objs.get(issue_num)
                if issue_obj:
                    db.add(models.EpisodeMember(
                        episode_id=None,  # no episode yet — placeholder linkage
                        commit_id=commit_obj.id,
                        issue_id=issue_obj.id,
                        member_type="issue_ref",
                    ))

>>>>>>> git_time_machine/main
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

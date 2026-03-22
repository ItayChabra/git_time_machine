import os
import time
import requests

GITHUB_API_BASE = "https://api.github.com"

# Maximum attempts for transient GitHub 5xx / network errors
_MAX_RETRIES = 3


class GitHubClient:
    def __init__(self, token: str | None = None):
        self.token = token or os.getenv("GITHUB_TOKEN")
        if not self.token:
            raise RuntimeError("GITHUB_TOKEN not set")

    def _headers(self):
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _get(self, url: str, **kwargs) -> requests.Response:
        """
        GET with exponential backoff for transient GitHub errors (5xx, 429).
        Raises on the final attempt if the error persists.
        """
        for attempt in range(_MAX_RETRIES):
            resp = requests.get(url, headers=self._headers(), **kwargs)
            if resp.status_code < 500 and resp.status_code != 429:
                resp.raise_for_status()
                return resp
            if attempt < _MAX_RETRIES - 1:
                wait = 2 ** attempt  # 1s, 2s, 4s
                time.sleep(wait)
        # Final attempt — let raise_for_status surface the real error
        resp.raise_for_status()
        return resp

    def get_repo(self, owner: str, repo: str):
        resp = self._get(f"{GITHUB_API_BASE}/repos/{owner}/{repo}")
        return resp.json()

    def list_commits(self, owner: str, repo: str, per_page: int = 20, max_pages: int = 1):
        commits = []
        for page in range(1, max_pages + 1):
            resp = self._get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits",
                params={"per_page": per_page, "page": page},
            )
            data = resp.json()
            if not data:
                break
            commits.extend(data)
        return commits

    def list_pulls(self, owner: str, repo: str, state="all", per_page: int = 100, max_pages: int = 5):
        pulls = []
        for page in range(1, max_pages + 1):
            resp = self._get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls",
                params={"state": state, "per_page": per_page, "page": page},
            )
            data = resp.json()
            if not data:
                break
            pulls.extend(data)
        return pulls

    def list_issues(self, owner: str, repo: str, state="all", per_page: int = 100, max_pages: int = 5):
        issues = []
        for page in range(1, max_pages + 1):
            resp = self._get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues",
                params={"state": state, "per_page": per_page, "page": page},
            )
            data = resp.json()
            if not data:
                break
            issues.extend(data)
        return issues

    def list_commit_files(self, owner: str, repo: str, sha: str):
        resp = self._get(f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits/{sha}")
        return resp.json().get("files", [])

    def list_pr_commit_shas(self, owner: str, repo: str, pr_number: int) -> list[str]:
        """
        Returns all commit SHAs for a PR, following pagination so PRs with
        more than 100 commits are fully covered.
        """
        shas: list[str] = []
        page = 1
        while True:
            try:
                resp = self._get(
                    f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{pr_number}/commits",
                    params={"per_page": 100, "page": page},
                )
            except requests.HTTPError:
                break
            data = resp.json()
            if not data:
                break
            shas.extend(c["sha"] for c in data)
            if len(data) < 100:
                break  # last page
            page += 1
        return shas
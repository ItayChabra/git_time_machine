import os
import requests

GITHUB_API_BASE = "https://api.github.com"

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

    def get_repo(self, owner: str, repo: str):
        resp = requests.get(f"{GITHUB_API_BASE}/repos/{owner}/{repo}", headers=self._headers())
        resp.raise_for_status()
        return resp.json()

    def list_commits(self, owner: str, repo: str, per_page: int = 20, max_pages: int = 1):
        commits = []
        for page in range(1, max_pages + 1):
            resp = requests.get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits",
                headers=self._headers(),
                params={"per_page": per_page, "page": page},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data:
                break
            commits.extend(data)
        return commits

    def list_pulls(self, owner: str, repo: str, state="all", per_page: int = 100, max_pages: int = 5):
        pulls = []
        for page in range(1, max_pages + 1):
            resp = requests.get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/pulls",
                headers=self._headers(),
                params={"state": state, "per_page": per_page, "page": page},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data:
                break
            pulls.extend(data)
        return pulls

    def list_issues(self, owner: str, repo: str, state="all", per_page: int = 100, max_pages: int = 5):
        issues = []
        for page in range(1, max_pages + 1):
            resp = requests.get(
                f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues",
                headers=self._headers(),
                params={"state": state, "per_page": per_page, "page": page},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data:
                break
            issues.extend(data)
        return issues

    def list_commit_files(self, owner: str, repo: str, sha: str):
        resp = requests.get(
            f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits/{sha}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("files", [])

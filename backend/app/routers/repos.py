from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException, Header
from sqlalchemy.orm import Session
from typing import Annotated

from ..database import SessionLocal
from .. import models, schemas
from ..credentials import Credentials
from ..ingestion import ingest_repo_commits
from .. import github_client
from ..models import RepoStatus

import os

router = APIRouter()


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
    """
    Read per-request credentials from headers sent by the VS Code extension.
    Falls back to environment variables for local dev / curl testing.
    """
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


@router.get("/by-name", response_model=schemas.RepoOut)
def get_repo_by_name(
    owner: str,
    name: str,
    db: Session = Depends(get_db),
):
    """
    Look up a repo by owner/name. Used by the extension to resolve the
    repo without the user needing to know the internal DB id.
    Returns 404 if the repo hasn't been ingested yet.
    """
    full_name = f"{owner}/{name}"
    repo = db.query(models.Repo).filter_by(full_name=full_name).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found — ingest it first")
    return repo


@router.post("/", response_model=schemas.RepoOut)
def add_repo(
    payload: schemas.RepoCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    creds: Credentials = Depends(get_credentials),
):
    gh = github_client.GitHubClient(token=creds.github_token)

    repo_data = gh.get_repo(payload.owner, payload.name)
    full_name = repo_data["full_name"]
    default_branch = repo_data["default_branch"]

    existing = db.query(models.Repo).filter_by(full_name=full_name).first()
    if existing:
        return existing

    repo = models.Repo(
        owner=payload.owner,
        name=payload.name,
        full_name=full_name,
        default_branch=default_branch,
        status=RepoStatus.indexing,
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)

    background_tasks.add_task(ingest_repo_commits, repo.id, creds, payload.max_commits)

    return repo


@router.post("/{repo_id}/refresh", response_model=schemas.RepoOut)
def refresh_repo(
    repo_id: int,
    background_tasks: BackgroundTasks,
    max_commits: int = 200,
    db: Session = Depends(get_db),
    creds: Credentials = Depends(get_credentials),
):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    repo.status = RepoStatus.indexing
    db.commit()
    db.refresh(repo)

    background_tasks.add_task(ingest_repo_commits, repo.id, creds, max_commits)

    return repo


@router.get("/", response_model=list[schemas.RepoOut])
def list_repos(db: Session = Depends(get_db)):
    return db.query(models.Repo).all()


@router.get("/{repo_id}", response_model=schemas.RepoOut)
def get_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    return repo
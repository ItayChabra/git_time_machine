from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session
from ..database import SessionLocal
from .. import models, schemas
from ..ingestion import ingest_repo_commits
from .. import github_client

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/", response_model=schemas.RepoOut)
def add_repo(
    payload: schemas.RepoCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    gh = github_client.GitHubClient()

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
        status="indexing",
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)

    background_tasks.add_task(ingest_repo_commits, repo.id, 20)

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

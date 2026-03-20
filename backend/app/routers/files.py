from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from ..database import SessionLocal
from .. import models, schemas
from ..episodes import episodes_for_file, file_story_for_file

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{repo_id}/list", response_model=list[schemas.FileEntry])
def list_files(repo_id: int, db: Session = Depends(get_db)):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    paths = (
        db.query(models.FileChange.file_path)
        .join(models.Commit)
        .filter(models.Commit.repo_id == repo_id)
        .distinct()
        .all()
    )
    return [schemas.FileEntry(path=p[0]) for p in paths]


@router.get("/{repo_id}/story", response_model=schemas.FileStory)
def get_file_story(repo_id: int, file_path: str = Query(...), db: Session = Depends(get_db)):
    repo = db.query(models.Repo).filter_by(id=repo_id).first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    ep_summaries = episodes_for_file(repo_id=repo_id, file_path=file_path, db=db)
    story = file_story_for_file(repo_id=repo_id, file_path=file_path, db=db)
    return schemas.FileStory(
        file_path=file_path,
        episodes=ep_summaries,
        file_story_summary=story,
    )

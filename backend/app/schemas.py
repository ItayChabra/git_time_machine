from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class RepoCreate(BaseModel):
    owner: str
    name: str

class RepoOut(BaseModel):
    id: int
    owner: str
    name: str
    full_name: str
    default_branch: str
    status: str

    class Config:
        from_attributes = True


class FileEntry(BaseModel):
    path: str

class EpisodeSummary(BaseModel):
    id: int
    title: str
    start_date: datetime
    end_date: datetime
    llm_summary: Optional[str] = None

    class Config:
        orm_mode = True

class FileStory(BaseModel):
    file_path: str
    episodes: List[EpisodeSummary]
    file_story_summary: Optional[str] = None


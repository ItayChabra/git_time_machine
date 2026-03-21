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
    pr_number: Optional[int] = None
    issue_number: Optional[int] = None

    class Config:
        from_attributes = True


class FileStory(BaseModel):
    file_path: str
    episodes: List[EpisodeSummary]
    file_story_summary: Optional[str] = None


class BlameStory(BaseModel):
    sha: str
    file_path: Optional[str] = None
    # hunk_start / hunk_end: the old-file line range of the matched hunk.
    # The extension uses these to check if a new originalLine falls in an
    # already-cached hunk, avoiding redundant API calls entirely.
    hunk_start: Optional[int] = None
    hunk_end: Optional[int] = None
    file_explanation: Optional[str] = None
    episode: Optional[EpisodeSummary] = None
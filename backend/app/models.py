from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from .database import Base

class Repo(Base):
    __tablename__ = "repos"
    id = Column(Integer, primary_key=True, index=True)
    owner = Column(String, index=True)
    name = Column(String, index=True)
    default_branch = Column(String, default="main")
    status = Column(String, default="indexing", nullable=False)
    full_name = Column(String, unique=True, index=True)  # "owner/name"

    commits = relationship("Commit", back_populates="repo")
    prs = relationship("PullRequest", back_populates="repo")
    issues = relationship("Issue", back_populates="repo")
    episodes = relationship("Episode", back_populates="repo")


class Commit(Base):
    __tablename__ = "commits"
    id = Column(Integer, primary_key=True, index=True)
    repo_id = Column(Integer, ForeignKey("repos.id"))
    pr_id = Column(Integer, ForeignKey("pull_requests.id"), nullable=True)
    
    sha = Column(String, unique=True, index=True)
    author = Column(String)
    date = Column(DateTime)
    message = Column(Text)

    repo = relationship("Repo", back_populates="commits")
    pr = relationship("PullRequest", back_populates="commits")

    file_changes = relationship("FileChange", back_populates="commit")
    episode_memberships = relationship("EpisodeMember", back_populates="commit")


class PullRequest(Base):
    __tablename__ = "pull_requests"
    id = Column(Integer, primary_key=True, index=True)
    repo_id = Column(Integer, ForeignKey("repos.id"))
    number = Column(Integer)
    title = Column(String)
    body = Column(Text)
    state = Column(String)
    merged_at = Column(DateTime)

    repo = relationship("Repo", back_populates="prs")
    commits = relationship("Commit", back_populates="pr")
    episode_memberships = relationship("EpisodeMember", back_populates="pr")


class Issue(Base):
    __tablename__ = "issues"
    id = Column(Integer, primary_key=True, index=True)
    repo_id = Column(Integer, ForeignKey("repos.id"))
    number = Column(Integer)
    title = Column(String)
    body = Column(Text)
    state = Column(String)

    repo = relationship("Repo", back_populates="issues")
    episode_memberships = relationship("EpisodeMember", back_populates="issue")


class FileChange(Base):
    __tablename__ = "file_changes"
    id = Column(Integer, primary_key=True, index=True)
    commit_id = Column(Integer, ForeignKey("commits.id"))
    file_path = Column(String, index=True)
    change_type = Column(String)  # added/modified/deleted

    commit = relationship("Commit", back_populates="file_changes")


class Episode(Base):
    __tablename__ = "episodes"
    id = Column(Integer, primary_key=True, index=True)
    repo_id = Column(Integer, ForeignKey("repos.id"))
    title = Column(String)
    start_date = Column(DateTime)
    end_date = Column(DateTime)
    llm_summary = Column(Text, nullable=True)  # later

    repo = relationship("Repo", back_populates="episodes")
    members = relationship("EpisodeMember", back_populates="episode")


class EpisodeMember(Base):
    __tablename__ = "episode_members"
    id = Column(Integer, primary_key=True, index=True)
    episode_id = Column(Integer, ForeignKey("episodes.id"))
    commit_id = Column(Integer, ForeignKey("commits.id"), nullable=True)
    pr_id = Column(Integer, ForeignKey("pull_requests.id"), nullable=True)
    issue_id = Column(Integer, ForeignKey("issues.id"), nullable=True)
    member_type = Column(String)  # "commit" / "pr" / "issue"

    episode = relationship("Episode", back_populates="members")
    commit = relationship("Commit", back_populates="episode_memberships")
    pr = relationship("PullRequest", back_populates="episode_memberships")
    issue = relationship("Issue", back_populates="episode_memberships")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from .config import DATABASE_URL

engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

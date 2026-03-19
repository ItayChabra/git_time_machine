from fastapi import FastAPI
from .database import Base, engine
from .routers import repos, files

app = FastAPI(title="Git Time Machine")

Base.metadata.create_all(bind=engine)

app.include_router(repos.router, prefix="/repos", tags=["repos"])
app.include_router(files.router, prefix="/files", tags=["files"])

@app.get("/health")
def health():
    return {"status": "ok"}

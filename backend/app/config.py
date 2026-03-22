import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL is missing from the .env file!")

# GEMINI_API_KEY and GITHUB_TOKEN are now supplied per-request by the VS Code
# extension (read from the user's own settings). They are no longer required as
# server-level environment variables.
#
# You can still set them here as fallbacks for local dev / curl testing:
#   GEMINI_API_KEY=...
#   GITHUB_TOKEN=...
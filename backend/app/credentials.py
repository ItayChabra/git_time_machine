from dataclasses import dataclass, field


@dataclass
class Credentials:
    github_token: str
    gemini_api_key: str
    gemini_model: str = "gemini-2.0-flash"
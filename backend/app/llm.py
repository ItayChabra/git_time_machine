import os
import random
import time
from typing import Any, Dict

from google import genai

DISABLE_LLM = os.getenv("DISABLE_LLM", "0").strip().lower() in {"1", "true", "yes", "y"}

MODEL_ID = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# Create the Gemini client only when enabled; this avoids failures in local dev.
client = None
if not DISABLE_LLM:
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def _truncate(text: str | None, max_chars: int) -> str:
    if not text:
        return ""
    return str(text).strip()[:max_chars]


def _is_rate_limit_error(exc: Exception) -> bool:
    status_code = getattr(exc, "status_code", None)
    if status_code == 429:
        return True
    msg = str(exc).upper()
    return ("RESOURCE_EXHAUSTED" in msg) or ("429" in msg) or ("RATE LIMIT" in msg)


def summarize_episode(context: Dict[str, Any]) -> str:
    """
    Summarize an episode with Gemini, with retry/backoff on rate limits.
    Returns a compact success string, or a controlled "Summary failed: ..." message.
    """
    if DISABLE_LLM:
        return "LLM disabled in this environment"

    if client is None:
        return "Summary failed: LLM client not configured (missing GEMINI_API_KEY)"

    pr_title = _truncate(context.get("pr_title"), 140)
    pr_body = _truncate(context.get("pr_body"), 1500)
    commit_messages = _truncate(context.get("commit_messages"), 1500)
    issue_title = _truncate(context.get("issue_title"), 180)
    issue_body = _truncate(context.get("issue_body"), 350)

    prompt = (
        "Explain this GitHub episode in 2-3 sentences:\n"
        "1) What changed\n"
        "2) Why it changed (problem/feature)\n"
        "3) Key assumptions/constraints\n\n"
        f"PR Title: {pr_title}\n"
        f"PR Body: {pr_body}\n"
        f"Commit Messages: {commit_messages}\n"
        f"Issue Title: {issue_title}\n"
        f"Issue Body: {issue_body}\n"
    )

    max_attempts = 4
    backoff_seconds = [30, 60, 120, 240]

    for attempt_idx in range(max_attempts):
        try:
            response = client.models.generate_content(model=MODEL_ID, contents=prompt)
            text = getattr(response, "text", None) or str(response)
            return text.strip()
        except Exception as e:
            if not _is_rate_limit_error(e):
                return f"Summary failed: {str(e)}"
            time.sleep(backoff_seconds[attempt_idx])
            if attempt_idx == max_attempts - 1:
                return "Summary failed: quota exhausted after retries"

    return "Summary failed: quota exhausted after retries"


def summarize_file_evolution(episodes_summaries: list[str]) -> str:
    """
    Summarize a file's evolution based on chronological episode summaries.
    """
    if DISABLE_LLM:
        return "LLM disabled in this environment"

    if client is None:
        return "File story failed: LLM client not configured (missing GEMINI_API_KEY)"

    episode_chunks = [s for s in (episodes_summaries or []) if s]
    if not episode_chunks:
        return "File story failed: no episode summaries provided"

    episode_chunks = [_truncate(s, 300) for s in episode_chunks]
    joined = "\n".join(f"- {s}" for s in episode_chunks)
    joined = _truncate(joined, 3500)

    prompt = (
        "Here is a chronological list of change summaries for a file.\n"
        "Write a 1-2 sentence high-level story of how this file has evolved.\n"
        "Be concise and developer-focused.\n\n"
        f"{joined}\n"
    )

    max_attempts = 3
    backoff_seconds = [30, 60, 120]

    for attempt_idx in range(max_attempts):
        try:
            response = client.models.generate_content(model=MODEL_ID, contents=prompt)
            time.sleep(random.uniform(2.5, 4.5))
            text = getattr(response, "text", None) or str(response)
            return text.strip()
        except Exception as e:
            if not _is_rate_limit_error(e):
                return f"File story failed: {str(e)}"
            time.sleep(backoff_seconds[attempt_idx])
            if attempt_idx == max_attempts - 1:
                return "File story failed: quota exhausted after retries"

    return "File story failed: quota exhausted after retries"


def explain_line_change(
    file_path: str,
    patch: str,
    commit_message: str,
    pr_title: str | None,
    pr_body: str | None,
) -> str:
    """
    Given the diff for a specific file in a specific commit, explain why
    those exact lines were changed. This is the core of the hover tooltip —
    scoped to the file the developer is actually looking at, not the whole PR.

    Returns an explanation string, or a controlled "Explanation failed: ..." message.
    """
    if DISABLE_LLM:
        return "LLM disabled in this environment"

    if client is None:
        return "Explanation failed: LLM client not configured (missing GEMINI_API_KEY)"

    # Truncate patch strictly to avoid context window issues on large diffs.
    # 3000 chars covers most real-world file changes without blowing the token budget.
    patch_truncated = _truncate(patch, 3000)
    commit_message_truncated = _truncate(commit_message, 300)
    pr_title_truncated = _truncate(pr_title, 140)
    pr_body_truncated = _truncate(pr_body, 800)

    prompt = (
        f"A developer is hovering over a line in `{file_path}` and wants to know "
        f"why this change was made.\n\n"
        f"Answer in 2-3 sentences. Be specific to this file and this diff — "
        f"not a generic PR summary. Focus on:\n"
        f"1) What specifically changed in this file\n"
        f"2) Why — what bug, requirement, or constraint drove it\n"
        f"3) Whether it is safe to modify (if inferable)\n\n"
        f"File: {file_path}\n"
        f"Commit message: {commit_message_truncated}\n"
        f"PR title: {pr_title_truncated}\n"
        f"PR description: {pr_body_truncated}\n\n"
        f"Diff:\n{patch_truncated}\n"
    )

    max_attempts = 3
    backoff_seconds = [30, 60, 120]

    for attempt_idx in range(max_attempts):
        try:
            response = client.models.generate_content(model=MODEL_ID, contents=prompt)
            text = getattr(response, "text", None) or str(response)
            return text.strip()
        except Exception as e:
            if not _is_rate_limit_error(e):
                return f"Explanation failed: {str(e)}"
            time.sleep(backoff_seconds[attempt_idx])
            if attempt_idx == max_attempts - 1:
                return "Explanation failed: quota exhausted after retries"

    return "Explanation failed: quota exhausted after retries"
import os
import random
import time
from typing import Any, Dict

from google import genai

DISABLE_LLM = os.getenv("DISABLE_LLM", "0").strip().lower() in {"1", "true", "yes", "y"}

MODEL_ID = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

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


def _call_llm(prompt: str, max_attempts: int = 3) -> str | None:
    """
    Shared LLM call with retry/backoff. Returns response text or None on failure.
    """
    if DISABLE_LLM or client is None:
        return None

    backoff_seconds = [30, 60, 120]
    for attempt_idx in range(max_attempts):
        try:
            response = client.models.generate_content(model=MODEL_ID, contents=prompt)
            text = getattr(response, "text", None) or str(response)
            return text.strip()
        except Exception as e:
            if not _is_rate_limit_error(e):
                return None
            time.sleep(backoff_seconds[attempt_idx])
    return None


def summarize_episode(context: Dict[str, Any]) -> str:
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

    result = _call_llm(prompt, max_attempts=4)
    return result or "Summary failed: quota exhausted after retries"


def summarize_file_evolution(episodes_summaries: list[str]) -> str:
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

    result = _call_llm(prompt)
    if result:
        time.sleep(random.uniform(2.5, 4.5))
        return result
    return "File story failed: quota exhausted after retries"


def explain_function(
    file_path: str,
    function_name: str,
    patch: str,
    commit_message: str,
    pr_title: str | None,
    pr_body: str | None,
) -> str:
    """
    Explain why a specific named function/class was changed in this commit.

    The function name comes from VS Code's symbol provider — it's the actual
    symbol the developer is hovering inside, not a line number guess.
    The full file patch is provided for context, but the prompt anchors the
    LLM on the specific named symbol so it can't get distracted by adjacent code.

    Answers the three questions developers actually need:
      1. What constraint/bug/requirement does this code encode?
      2. What breaks if you remove or change it?
      3. Is it safe to modify, and what must be preserved?
    """
    if DISABLE_LLM or client is None:
        return "LLM disabled in this environment"

    patch_truncated = _truncate(patch, 3000)
    commit_truncated = _truncate(commit_message, 300)
    pr_title_truncated = _truncate(pr_title, 140)
    pr_body_truncated = _truncate(pr_body, 600)

    prompt = (
        f"A developer is hovering inside the function/class `{function_name}` "
        f"in `{file_path}` and wants to understand why this code exists.\n\n"
        f"Focus ONLY on `{function_name}`. Ignore other functions in the diff.\n\n"
        f"Answer in 3 sentences — one per question:\n"
        f"1) What constraint, bug, or requirement does `{function_name}` encode? "
        f"   (Not just what it does — why it has to exist this way.)\n"
        f"2) What would break or regress if a developer removed or changed it?\n"
        f"3) Is it safe to modify? If yes, what must be preserved. "
        f"   If no, what makes it dangerous to touch.\n\n"
        f"Commit message: {commit_truncated}\n"
        f"PR title: {pr_title_truncated}\n"
        f"PR description: {pr_body_truncated}\n\n"
        f"Diff (full file patch — focus only on `{function_name}`):\n"
        f"{patch_truncated}\n"
    )

    result = _call_llm(prompt)
    return result or "Explanation failed: quota exhausted after retries"


def explain_hunk(
    file_path: str,
    hunk: str,
    commit_message: str,
    pr_title: str | None,
    pr_body: str | None,
) -> str:
    """
    Fallback for when no VS Code symbol was found (global scope, blank lines,
    unsupported language). Explains the hunk without a function anchor.
    Same three-question format as explain_function.
    """
    if DISABLE_LLM or client is None:
        return "LLM disabled in this environment"

    hunk_truncated = _truncate(hunk, 3000)
    commit_truncated = _truncate(commit_message, 300)
    pr_title_truncated = _truncate(pr_title, 140)
    pr_body_truncated = _truncate(pr_body, 600)

    prompt = (
        f"A developer is reading `{file_path}` and wants to understand "
        f"the code they are looking at before deciding whether to change it.\n\n"
        f"Answer in 3 sentences — one per question:\n"
        f"1) What constraint, bug, or requirement does this code encode?\n"
        f"2) What would break or regress if it were removed or changed?\n"
        f"3) Is it safe to modify? If yes, what must be preserved. "
        f"   If no, what makes it dangerous to touch.\n\n"
        f"Commit message: {commit_truncated}\n"
        f"PR title: {pr_title_truncated}\n"
        f"PR description: {pr_body_truncated}\n\n"
        f"Diff:\n{hunk_truncated}\n"
    )

    result = _call_llm(prompt)
    return result or "Explanation failed: quota exhausted after retries"
"""
Web research — Gemini google_search grounding for the autonomous agent.

Invoked selectively when the Pinecone corpus is weak or when the task type
warrants broader coverage (user_directive, test_theory). Mirrors the pattern
used in api/index.py's /api/cases/{id}/graph/research endpoint.
"""

import urllib.parse

from google.genai import types

from agent.config import (
    get_genai,
    WEB_SEARCH_ENABLED, WEB_SEARCH_MODEL,
    WEB_SEARCH_MIN_HITS, WEB_SEARCH_MIN_SCORE, WEB_SEARCH_MAX_RESULTS,
)
from llm import generate


# Task types that always benefit from public-web context (when enabled).
_ALWAYS_WEB_TASK_TYPES = {"user_directive", "test_theory"}
# Task types that should never trigger web search — graph-bound or summary tasks.
_NEVER_WEB_TASK_TYPES = {"validate_existing", "expand_branch"}


def should_web_search(task: dict, corpus_hits: list) -> bool:
    """Decide whether to augment a task with a web-search pass.

    Policy:
      - Disabled entirely when WEB_SEARCH_ENABLED=False.
      - Never for graph-bound tasks (validate_existing, expand_branch).
      - Always for user_directive / test_theory (broad reach matters).
      - Otherwise only when the corpus result set is weak:
          len(corpus_hits) < WEB_SEARCH_MIN_HITS  OR  top score < WEB_SEARCH_MIN_SCORE.
    """
    if not WEB_SEARCH_ENABLED:
        return False
    task_type = (task or {}).get("type", "")
    if task_type in _NEVER_WEB_TASK_TYPES:
        return False
    if task_type in _ALWAYS_WEB_TASK_TYPES:
        return True
    if not corpus_hits or len(corpus_hits) < WEB_SEARCH_MIN_HITS:
        return True
    top_score = max((c.get("score") or 0) for c in corpus_hits)
    return top_score < WEB_SEARCH_MIN_SCORE


def web_search(query: str, context: str = "", model: str = None) -> dict:
    """Run a Gemini google_search grounded query.

    Returns {"text": str, "citations": [{title, uri, domain}], "used": bool}.
    On any error returns {"text": "", "citations": [], "used": False}.
    """
    if not WEB_SEARCH_ENABLED:
        return {"text": "", "citations": [], "used": False}

    q = (query or "").strip()
    if not q:
        return {"text": "", "citations": [], "used": False}

    prompt_parts = [
        "You are an investigative research assistant. Use web search to gather "
        "accurate, sourced information about the following query. Prioritize court "
        "records, DOJ filings, investigative journalism, and public records. "
        "Respond with a concise factual summary (3-6 sentences) followed by any "
        "notable entities, dates, and connections. Every factual claim should be "
        "supported by the returned web sources.\n"
    ]
    if context:
        prompt_parts.append(f"CONTEXT (prior findings):\n{context[:1500]}\n")
    prompt_parts.append(f"QUERY: {q}")

    try:
        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        )
        res = generate(
            get_genai(),
            model=(model or WEB_SEARCH_MODEL),
            contents="\n\n".join(prompt_parts),
            config=config,
        )
    except Exception as e:
        print(f"[web_research] Gemini google_search failed: {e}")
        return {"text": "", "citations": [], "used": False}

    text = (getattr(res, "text", "") or "").strip()

    citations = []
    candidates = getattr(res, "candidates", None) or []
    if candidates:
        gm = getattr(candidates[0], "grounding_metadata", None)
        chunks = getattr(gm, "grounding_chunks", None) if gm else None
        if chunks:
            for gc in chunks:
                web = getattr(gc, "web", None)
                if not web:
                    continue
                uri = getattr(web, "uri", "") or ""
                if not uri:
                    continue
                try:
                    domain = urllib.parse.urlparse(uri).netloc.removeprefix("www.")
                except Exception:
                    domain = ""
                citations.append({
                    "title": getattr(web, "title", "") or "",
                    "uri": uri,
                    "domain": domain,
                })
                if len(citations) >= WEB_SEARCH_MAX_RESULTS:
                    break

    return {"text": text, "citations": citations, "used": bool(text or citations)}


def format_web_evidence(web_result: dict) -> str:
    """Render a web_search result as an LLM-prompt evidence block.
    Returns an empty string when the web pass was skipped or produced nothing."""
    if not web_result or not web_result.get("used"):
        return ""
    citations = web_result.get("citations", [])
    lines = []
    for i, c in enumerate(citations):
        lines.append(f"[w{i}] {c.get('title') or c.get('domain') or c.get('uri')} "
                     f"<{c.get('uri', '')}>")
    cite_block = "\n".join(lines) if lines else "(no URLs returned)"
    text = (web_result.get("text") or "").strip()
    return (
        "WEB EVIDENCE (from live Google Search — cite these with their URLs "
        "and include URLs in any timeline_event sources you derive from them):\n"
        f"{text}\n\nURL CITATIONS:\n{cite_block}"
    )


def citations_as_sources(web_result: dict) -> list:
    """Convert web citations to the case-evidence `sources` array shape.
    Each source dict is written into the existing JSONB `sources` column; no schema change."""
    if not web_result or not web_result.get("used"):
        return []
    out = []
    for c in web_result.get("citations", []):
        uri = c.get("uri")
        if not uri:
            continue
        out.append({
            "type": "web",
            "uri": uri,
            "title": c.get("title") or "",
            "domain": c.get("domain") or "",
        })
    return out

"""
Agent memory — tracks what has already been investigated to prevent loops.
"""

from agent.config import get_supabase, content_hash


def has_investigated(memory_type: str, content: str) -> bool:
    """Check if we've already investigated this exact thing."""
    sb = get_supabase()
    h = content_hash(content)
    res = sb.table("agent_memory").select("id").eq(
        "memory_type", memory_type
    ).eq("content_hash", h).limit(1).execute()
    return len(res.data) > 0


def record_investigation(memory_type: str, content: str, outcome: str, case_id: str = None):
    """Record that we investigated something and what we found."""
    sb = get_supabase()
    h = content_hash(content)
    sb.table("agent_memory").upsert({
        "memory_type": memory_type,
        "content": content,
        "content_hash": h,
        "outcome": outcome,
        "case_id": case_id,
    }, on_conflict="memory_type,content_hash").execute()


def get_investigation_count() -> int:
    """How many total investigations have been recorded."""
    sb = get_supabase()
    res = sb.table("agent_memory").select("id", count="exact").execute()
    return res.count or 0


def get_related_memories(case_id: str = None, keywords: list = None, limit: int = 8) -> list:
    """Return prior investigations relevant to the current task.

    Fetches the most recent 50 memory rows (filtered by case_id if given),
    scores them by keyword overlap against content+outcome, and returns the
    top `limit` matches. When no keywords are provided, returns the most
    recent `limit` rows for the case.
    """
    sb = get_supabase()
    q = sb.table("agent_memory").select(
        "memory_type, content, outcome, case_id, created_at"
    )
    if case_id:
        q = q.eq("case_id", case_id)
    res = q.order("created_at", desc=True).limit(50).execute()
    items = res.data or []
    if not items:
        return []
    if not keywords:
        return items[:limit]
    kws = {k.lower() for k in keywords if k and len(k) > 3}
    if not kws:
        return items[:limit]
    scored = []
    for item in items:
        blob = f"{item.get('content', '')} {item.get('outcome') or ''}".lower()
        score = sum(1 for k in kws if k in blob)
        if score > 0:
            scored.append((score, item))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [item for _, item in scored[:limit]]

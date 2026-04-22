"""
Agent task queue — manages what the agent should investigate next.
"""

import re
from typing import Optional
from agent.config import get_supabase


# Valid research_depth values. Encoded into the task description as a
# `[depth=X] ` prefix so no schema migration is required.
VALID_DEPTHS = {"shallow", "standard", "deep"}
_DEPTH_PREFIX_RE = re.compile(r"^\s*\[depth=(shallow|standard|deep)\]\s*", re.IGNORECASE)


def parse_research_depth(description) -> tuple[str, str]:
    """Extract a research_depth prefix from a task description.
    Returns (depth, cleaned_description). Defaults to "standard" when absent."""
    if isinstance(description, dict):
        description = description.get("description") or description.get("lead") or description.get("title") or str(description)
    if not description:
        return "standard", description or ""
    m = _DEPTH_PREFIX_RE.match(description)
    if not m:
        return "standard", description
    depth = m.group(1).lower()
    cleaned = description[m.end():]
    return depth, cleaned


def get_research_depth(task: dict) -> str:
    """Read the research_depth encoded in a task's description prefix."""
    depth, _ = parse_research_depth((task or {}).get("description", ""))
    return depth


def enqueue_task(
    task_type: str,
    description: str,
    priority: int = 5,
    case_id: str = None,
    parent_task_id: str = None,
    research_depth: str = None,
) -> dict:
    """Add a task to the investigation queue. Returns the created task.

    `research_depth` (shallow/standard/deep) gates model choice, web search,
    and iterative deepening inside strategies. Encoded as a `[depth=X] ` prefix
    on the description so no schema change is needed.
    """
    sb = get_supabase()
    # LLM responses sometimes return dicts instead of strings for leads/theories
    if isinstance(description, dict):
        description = description.get("description") or description.get("lead") or description.get("title") or str(description)
    final_desc = str(description) if description else ""
    if research_depth:
        rd = research_depth.lower()
        if rd in VALID_DEPTHS:
            # Strip any existing depth tag to avoid duplicates, then re-apply
            _, cleaned = parse_research_depth(final_desc)
            final_desc = f"[depth={rd}] {cleaned}"
    task = {
        "type": task_type,
        "description": final_desc,
        "priority": priority,
        "status": "queued",
        "case_id": case_id,
        "parent_task_id": parent_task_id,
    }
    res = sb.table("agent_tasks").insert(task).execute()
    return res.data[0] if res.data else task


def next_task() -> Optional[dict]:
    """
    Get the next task to work on.
    Priority: user_directives first (priority 1), then by priority ASC, then oldest first.
    Claims the task by setting status to in_progress.
    """
    sb = get_supabase()
    res = (
        sb.table("agent_tasks")
        .select("*")
        .eq("status", "queued")
        .order("priority", desc=False)
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    if not res.data:
        return None

    task = res.data[0]
    # Claim it
    sb.table("agent_tasks").update({
        "status": "in_progress",
        "started_at": "now()",
    }).eq("id", task["id"]).execute()

    return task


def complete_task(task_id: str, result_summary: str):
    """Mark a task as completed with a summary of what was found."""
    sb = get_supabase()
    sb.table("agent_tasks").update({
        "status": "completed",
        "result_summary": result_summary,
        "completed_at": "now()",
    }).eq("id", task_id).execute()


def fail_task(task_id: str, error: str):
    """Mark a task as failed."""
    sb = get_supabase()
    sb.table("agent_tasks").update({
        "status": "failed",
        "result_summary": f"ERROR: {error}",
        "completed_at": "now()",
    }).eq("id", task_id).execute()


def get_queue_stats() -> dict:
    """Get counts of tasks by status."""
    sb = get_supabase()
    queued = sb.table("agent_tasks").select("id", count="exact").eq("status", "queued").execute()
    in_progress = sb.table("agent_tasks").select("id", count="exact").eq("status", "in_progress").execute()
    completed = sb.table("agent_tasks").select("id", count="exact").eq("status", "completed").execute()
    failed = sb.table("agent_tasks").select("id", count="exact").eq("status", "failed").execute()
    return {
        "queued": queued.count or 0,
        "in_progress": in_progress.count or 0,
        "completed": completed.count or 0,
        "failed": failed.count or 0,
    }

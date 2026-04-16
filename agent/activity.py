"""
Agent activity logging — feeds the mission control UI.
"""

import json
from datetime import datetime, timezone
from agent.config import get_supabase


def log_activity(
    action: str,
    description: str,
    task_id: str = None,
    case_id: str = None,
    entity_ids: list = None,
    metadata: dict = None,
):
    """Log an agent action to the activity feed."""
    sb = get_supabase()
    entry = {
        "action": action,
        "description": description,
        "task_id": task_id,
        "case_id": case_id,
        "entity_ids": entity_ids or [],
        "metadata": metadata or {},
    }
    sb.table("agent_activity").insert(entry).execute()
    # Also print to console for local dev
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"  [{ts}] {action}: {description}")


def update_agent_status(
    is_running: bool = None,
    current_task_id: str = None,
    increment_completed: bool = False,
    increment_theories: bool = False,
    increment_entities: int = 0,
    increment_cases: bool = False,
):
    """Update the singleton agent_status row."""
    sb = get_supabase()

    updates = {"last_heartbeat": "now()"}
    if is_running is not None:
        updates["is_running"] = is_running
        if is_running:
            updates["started_at"] = "now()"
            updates["paused_at"] = None
        else:
            updates["paused_at"] = "now()"
    if current_task_id is not None:
        updates["current_task_id"] = current_task_id

    sb.table("agent_status").update(updates).eq("id", 1).execute()

    # Handle increments separately with RPC or read-modify-write
    if increment_completed or increment_theories or increment_entities or increment_cases:
        current = sb.table("agent_status").select("*").eq("id", 1).execute()
        if current.data:
            row = current.data[0]
            inc_updates = {}
            if increment_completed:
                inc_updates["tasks_completed"] = (row.get("tasks_completed") or 0) + 1
            if increment_theories:
                inc_updates["theories_tested"] = (row.get("theories_tested") or 0) + 1
            if increment_entities:
                inc_updates["entities_added"] = (row.get("entities_added") or 0) + increment_entities
            if increment_cases:
                inc_updates["cases_created"] = (row.get("cases_created") or 0) + 1
            if inc_updates:
                sb.table("agent_status").update(inc_updates).eq("id", 1).execute()

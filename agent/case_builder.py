"""
Case builder — creates and populates hierarchical cases from agent findings.
Handles: case creation, entity addition, edge creation, timeline events, notes.
"""

from typing import Optional
from agent.config import get_supabase, MAX_CASE_DEPTH
from agent.activity import log_activity, update_agent_status


# ---- Case metrics ----

def get_case_counts(case_id: str) -> dict:
    """Return entity, evidence, and timeline counts for a case."""
    sb = get_supabase()
    entity_count = sb.table("case_graph_entities").select("id", count="exact").eq("case_id", case_id).execute()
    evidence_count = sb.table("case_evidence").select("id", count="exact").eq("case_id", case_id).execute()
    timeline_count = sb.table("case_timeline_events").select("id", count="exact").eq("case_id", case_id).execute()
    return {
        "entity_count": entity_count.count or 0,
        "evidence_count": evidence_count.count or 0,
        "timeline_count": timeline_count.count or 0,
    }


# ---- Case CRUD ----

def create_case(
    title: str,
    category: str,
    summary: str,
    parent_case_id: str = None,
    operational_question: str = None,
    entities: list = None,
    suggested_questions: list = None,
) -> dict:
    """Create a new case (optionally as a child of a parent case)."""
    sb = get_supabase()

    # Calculate depth from parent
    depth = 0
    if parent_case_id:
        parent = sb.table("cases").select("*").eq("id", parent_case_id).execute()
        if parent.data:
            depth = (parent.data[0].get("depth") or 0) + 1
            # Cap depth — return parent case instead of creating deeper
            if depth > MAX_CASE_DEPTH:
                print(f"[case_builder] Depth cap hit ({depth} > {MAX_CASE_DEPTH}), returning parent case")
                return parent.data[0]

    case = {
        "title": title,
        "category": category,
        "summary": summary,
        "status": "active",
        "parent_case_id": parent_case_id,
        "depth": depth,
        "operational_question": operational_question,
        "entities": entities or [],
        "suggested_questions": suggested_questions or [],
        "is_public": True,
    }
    res = sb.table("cases").insert(case).execute()
    created = res.data[0] if res.data else case

    log_activity(
        action="created_case",
        description=f"Created case: {title}",
        case_id=created.get("id"),
        metadata={"category": category, "parent_case_id": parent_case_id, "depth": depth},
    )
    update_agent_status(increment_cases=True)
    return created


def update_case_summary(case_id: str, summary: str):
    """Update a case's summary with new findings."""
    sb = get_supabase()
    sb.table("cases").update({"summary": summary}).eq("id", case_id).execute()


def find_or_create_subcase(
    parent_case_id: str,
    title: str,
    category: str,
    summary: str,
) -> dict:
    """Find an existing sub-case by title under a parent, or create one."""
    sb = get_supabase()
    # Check for existing
    existing = (
        sb.table("cases")
        .select("*")
        .eq("parent_case_id", parent_case_id)
        .ilike("title", title)
        .limit(1)
        .execute()
    )
    if existing.data:
        return existing.data[0]
    return create_case(
        title=title,
        category=category,
        summary=summary,
        parent_case_id=parent_case_id,
    )


def get_child_cases(parent_case_id: str) -> list:
    """Get all child cases of a parent."""
    sb = get_supabase()
    res = sb.table("cases").select("*").eq("parent_case_id", parent_case_id).execute()
    return res.data or []


def get_root_cases() -> list:
    """Get all top-level cases (no parent)."""
    sb = get_supabase()
    res = sb.table("cases").select("*").is_("parent_case_id", "null").execute()
    return res.data or []


# ---- Case entities (network graph) ----

def add_entity_to_case(case_id: str, node_id: str, description: str = None):
    """Add an entity from the global graph to a case's network."""
    sb = get_supabase()
    entry = {
        "case_id": case_id,
        "node_id": node_id,
    }

    # Upsert to avoid duplicates
    sb.table("case_graph_entities").upsert(
        entry, on_conflict="case_id,node_id"
    ).execute()

    log_activity(
        action="added_entity",
        description=f"Added entity {node_id} to case",
        case_id=case_id,
        entity_ids=[node_id],
    )
    update_agent_status(increment_entities=1)


def add_edge_to_case(
    case_id: str,
    source_id: str,
    target_id: str,
    label: str,
) -> dict:
    """Add a relationship edge to a case's network."""
    sb = get_supabase()
    edge = {
        "case_id": case_id,
        "source_node_id": source_id,
        "target_node_id": target_id,
        "label": label,
    }
    # Upsert to avoid duplicate edge errors
    res = sb.table("case_graph_edges").upsert(
        edge, on_conflict="case_id,source_node_id,target_node_id"
    ).execute()
    return res.data[0] if res.data else edge


# ---- Case evidence / notes ----

def add_evidence(
    case_id: str,
    content: str,
    evidence_type: str = "investigation",
    sources: list = None,
):
    """Add evidence or a note to a case."""
    sb = get_supabase()
    entry = {
        "case_id": case_id,
        "type": evidence_type,
        "content": content,
        "sources": sources,
    }
    sb.table("case_evidence").insert(entry).execute()

    log_activity(
        action="added_evidence",
        description=f"Added {evidence_type} to case",
        case_id=case_id,
        metadata={"type": evidence_type, "length": len(content)},
    )


# ---- Timeline events ----

def add_timeline_event(
    case_id: str,
    title: str,
    event_date: str = None,
    description: str = "",
    category: str = "general",
    sources: list = None,
) -> dict:
    """Add a timeline event to a case."""
    sb = get_supabase()
    event = {
        "case_id": case_id,
        "title": title,
        "event_date": event_date,
        "description": description,
        "category": category,
        "sources": sources,
    }
    res = sb.table("case_timeline_events").insert(event).execute()

    log_activity(
        action="added_timeline_event",
        description=f"Timeline: {title}" + (f" ({event_date})" if event_date else ""),
        case_id=case_id,
    )
    return res.data[0] if res.data else event


# ---- Global graph entity lookup ----

def get_entity(node_id: str) -> Optional[dict]:
    """Fetch a global graph entity by ID."""
    sb = get_supabase()
    res = sb.table("nodes").select("*").eq("id", node_id).limit(1).execute()
    return res.data[0] if res.data else None


def search_entities(query: str, limit: int = 10, min_confidence: float = 0.0) -> list:
    """Search global graph entities by label with tiered matching.

    Returns entities sorted best-first, each with a `match_confidence` field (0..1):
      - 1.0  exact label match (case-insensitive)
      - 0.9  alias match
      - <1.0 ilike "%q%" substring match; confidence = len(q)/len(label)

    Substring matches require len(query) >= 4 to avoid short-token false positives
    (e.g. "Bill" matching every name containing those letters).
    """
    sb = get_supabase()
    q = (query or "").strip()
    if not q:
        return []

    cols = "id, label, type, description, aliases"
    results: list = []
    seen_ids: set = set()

    # Tier 1: exact match (ilike without wildcards is case-insensitive equality)
    try:
        exact = sb.table("nodes").select(cols).ilike("label", q).limit(limit).execute()
        for r in (exact.data or []):
            if r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                results.append({**r, "match_confidence": 1.0})
    except Exception:
        pass

    # Tier 2: alias array match
    if len(results) < limit:
        try:
            alias = (
                sb.table("nodes")
                .select(cols)
                .contains("aliases", [q])
                .limit(limit)
                .execute()
            )
            for r in (alias.data or []):
                if r["id"] not in seen_ids:
                    seen_ids.add(r["id"])
                    results.append({**r, "match_confidence": 0.9})
        except Exception:
            # aliases column may not support .contains in all schemas — skip silently
            pass

    # Tier 3: fuzzy substring — only for non-trivially-short queries
    if len(q) >= 4 and len(results) < limit:
        try:
            fuzzy = (
                sb.table("nodes")
                .select(cols)
                .ilike("label", f"%{q}%")
                .limit(limit * 2)
                .execute()
            )
            for r in (fuzzy.data or []):
                if r["id"] in seen_ids:
                    continue
                label = r.get("label") or ""
                if not label:
                    continue
                conf = round(len(q) / max(len(label), 1), 2)
                if conf >= min_confidence:
                    seen_ids.add(r["id"])
                    results.append({**r, "match_confidence": conf})
        except Exception:
            pass

    results = [r for r in results if r["match_confidence"] >= min_confidence]
    results.sort(key=lambda r: r["match_confidence"], reverse=True)
    return results[:limit]


def get_entity_edges(node_id: str, limit: int = 50) -> list:
    """Get all edges connected to an entity."""
    sb = get_supabase()
    # Edges where this entity is source or target
    as_source = sb.table("edges").select("*").eq("source", node_id).limit(limit).execute()
    as_target = sb.table("edges").select("*").eq("target", node_id).limit(limit).execute()
    return (as_source.data or []) + (as_target.data or [])


def get_high_degree_entities(min_degree: int = 10, limit: int = 50) -> list:
    """Get entities with many connections (hubs in the network)."""
    sb = get_supabase()
    # Use metadata.degree if available, otherwise fall back to simple query
    res = (
        sb.table("nodes")
        .select("id, label, type, description, aliases, metadata")
        .limit(limit)
        .execute()
    )
    # Filter by degree from metadata
    entities = []
    for node in (res.data or []):
        meta = node.get("metadata") or {}
        degree = meta.get("degree", 0)
        if degree >= min_degree:
            entities.append({**node, "degree": degree})
    # Sort by degree descending
    entities.sort(key=lambda x: x.get("degree", 0), reverse=True)
    return entities[:limit]

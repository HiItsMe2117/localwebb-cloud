#!/usr/bin/env python3
"""
Autonomous Investigation Agent — LocalWebb

Continuous investigation loop that:
1. Checks the priority queue for user directives
2. Picks the next task (or generates one)
3. Investigates using strategies (semantic search, graph traversal, LLM analysis)
4. Structures findings into hierarchical cases (entities, edges, timelines, notes)
5. Discovers new leads and queues them
6. Logs everything to the activity feed

Run: python -m agent.autonomous_agent
"""

import time
import signal
import sys
import traceback

from agent.config import (
    get_supabase, get_genai, CYCLE_COOLDOWN, THEORY_CONFIDENCE_COMMIT,
    MAX_CASE_ENTITIES, MAX_CASE_EVIDENCE, FAST_MODEL, EMBEDDING_MODEL,
    content_hash, BIGGER_PICTURE_INTERVAL,
)
from agent.queue import next_task, complete_task, fail_task, enqueue_task, get_queue_stats
from agent.memory import has_investigated, record_investigation
from agent.activity import log_activity, update_agent_status
from agent.case_builder import (
    create_case, find_or_create_subcase, add_entity_to_case,
    add_edge_to_case, add_evidence, add_timeline_event,
    get_root_cases, get_child_cases, get_case_counts,
    get_high_degree_entities, search_entities,
)
from agent.strategies import (
    validate_entity, entity_deep_dive, generate_and_test_theory,
    explore_connection, expand_branch,
)

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------
_running = True

def _shutdown(sig, frame):
    global _running
    print("\n[agent] Shutdown signal received, finishing current cycle...")
    _running = False

signal.signal(signal.SIGINT, _shutdown)
signal.signal(signal.SIGTERM, _shutdown)


# ---------------------------------------------------------------------------
# Operational question → case branch mapping
# ---------------------------------------------------------------------------
OPERATIONAL_QUESTIONS = [
    {
        "title": "Financial Infrastructure",
        "category": "money_laundering",
        "operational_question": "How was the network funded and what was the financial infrastructure?",
        "summary": "Investigation into the financial mechanisms that funded and sustained the Epstein network: shell companies, trusts, bank relationships, money flows, and financial enablers.",
    },
    {
        "title": "Recruitment & Trafficking Pipeline",
        "category": "trafficking",
        "operational_question": "How were people recruited, moved, and controlled?",
        "summary": "Investigation into the recruitment methods, transportation logistics, and control mechanisms used by the network to exploit victims.",
    },
    {
        "title": "Legal Protection & Cover-ups",
        "category": "obstruction",
        "operational_question": "How was the network protected from law enforcement and media?",
        "summary": "Investigation into how the network avoided accountability: legal deals, law enforcement interference, media suppression, and political protection.",
    },
    {
        "title": "Intelligence Relationships",
        "category": "other",
        "operational_question": "What intelligence relationships existed and what was exchanged?",
        "summary": "Investigation into alleged intelligence connections: Mossad, CIA, and other agencies. What information or leverage was exchanged, and what operations were supported?",
    },
    {
        "title": "Cover Organizations & Fronts",
        "category": "fraud",
        "operational_question": "What legitimate-looking organizations served as cover, and for what?",
        "summary": "Investigation into organizations that provided cover for network activities: nonprofits, foundations, businesses, and their true operational functions.",
    },
    {
        "title": "Geopolitical Operations",
        "category": "other",
        "operational_question": "What geopolitical operations was the network involved in?",
        "summary": "Investigation into the network's involvement in international affairs: Iran-Contra, China-Africa deals, sovereignty claims, and other geopolitical entanglements.",
    },
    {
        "title": "The Bigger Picture",
        "category": "bigger_picture",
        "operational_question": "What patterns, connections, and narratives emerge when viewing all investigations together?",
        "summary": "Cross-case synthesis identifying connections, contradictions, and emergent narratives across all active investigations.",
    },
]


def seed_root_cases():
    """Create the 6 top-level operational cases if they don't exist."""
    sb = get_supabase()
    existing = get_root_cases()
    existing_titles = {c["title"].lower() for c in existing}

    created = 0
    for oq in OPERATIONAL_QUESTIONS:
        if oq["title"].lower() not in existing_titles:
            case = create_case(
                title=oq["title"],
                category=oq["category"],
                summary=oq["summary"],
                operational_question=oq["operational_question"],
            )
            # Seed initial investigation tasks for this branch
            enqueue_task(
                task_type="expand_branch",
                description=f"Initial exploration of: {oq['title']}",
                priority=3,
                case_id=case["id"],
            )
            created += 1
            print(f"  Seeded root case: {oq['title']}")

    if created:
        log_activity(
            action="seeded_cases",
            description=f"Seeded {created} root operational cases",
            metadata={"count": created},
        )
    return created


def seed_initial_tasks():
    """Generate initial tasks from the existing knowledge graph."""
    stats = get_queue_stats()
    if stats["queued"] > 0:
        print(f"[agent] Queue already has {stats['queued']} tasks, skipping seed")
        return

    # Get high-degree entities for validation
    hub_entities = get_high_degree_entities(min_degree=10, limit=20)
    print(f"[agent] Found {len(hub_entities)} hub entities to validate")

    for entity in hub_entities[:15]:
        if not has_investigated("investigated_entity", entity["id"]):
            enqueue_task(
                task_type="validate_existing",
                description=entity["id"],
                priority=4,
            )

    # Also seed some entity deep-dives for the most connected entities.
    # Hub entities warrant "deep" research (gemini-2.5-pro + web search + one
    # follow-up round) — they anchor the graph, so getting them right matters.
    for entity in hub_entities[:5]:
        if not has_investigated("investigated_entity", entity["label"]):
            enqueue_task(
                task_type="investigate_entity",
                description=entity["label"],
                priority=3,
                research_depth="deep",
            )

    log_activity(
        action="seeded_tasks",
        description=f"Seeded {min(len(hub_entities), 15)} validation tasks and {min(len(hub_entities), 5)} deep-dive tasks",
    )


# ---------------------------------------------------------------------------
# Route task to strategy
# ---------------------------------------------------------------------------

def _map_case_branch(result: dict, task: dict) -> str:
    """Determine which ROOT case branch findings belong to. Returns case_id."""
    case_id = task.get("case_id")
    if case_id:
        return case_id

    # Try to match based on result's case_branch field
    branch_name = result.get("case_branch", "").lower()
    if not branch_name:
        return None

    root_cases = get_root_cases()
    for case in root_cases:
        if any(kw in branch_name for kw in case["title"].lower().split()):
            return case["id"]
        if case.get("operational_question") and branch_name in case["operational_question"].lower():
            return case["id"]

    return None


# Sub-case routing: cache embeddings by case text hash so we only embed once
# per sub-case per agent process lifetime.
_SUBCASE_EMBED_CACHE: dict = {}
_ROUTING_MIN_SIM = 0.45  # below this, stay at the root case


def _cosine(a: list, b: list) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _embed_text(text: str) -> list:
    try:
        res = get_genai().models.embed_content(model=EMBEDDING_MODEL, contents=[text])
        return list(res.embeddings[0].values)
    except Exception as e:
        print(f"[routing] embed failed: {e}")
        return []


def _case_embedding(case: dict) -> list:
    """Return a cached embedding for a case; re-embed when title+summary changes."""
    cid = case.get("id")
    if not cid:
        return []
    key_text = f"{case.get('title', '')} :: {(case.get('summary') or '')[:300]}"
    h = content_hash(key_text)
    cached = _SUBCASE_EMBED_CACHE.get(cid)
    if cached and cached[0] == h:
        return cached[1]
    vec = _embed_text(key_text)
    if vec:
        _SUBCASE_EMBED_CACHE[cid] = (h, vec)
    return vec


def _findings_query_text(result: dict) -> str:
    """Produce the text we embed to match against sub-cases."""
    parts = []
    for field in ("summary", "intelligence_note", "intelligence_brief", "function_analysis", "write_up", "reasoning"):
        v = result.get(field)
        if v:
            parts.append(str(v))
            break
    for entity in (result.get("entities_found", []) or []) + (result.get("entities_involved", []) or []):
        name = entity.get("name")
        if name:
            parts.append(name)
    for conn in (result.get("connections", []) or []) + (result.get("key_connections", []) or []):
        for field in ("from", "to", "target", "relationship"):
            v = conn.get(field)
            if v:
                parts.append(str(v))
    return " | ".join(parts)[:1500]


def _route_to_subcase(root_case_id: str, result: dict) -> str:
    """Route findings to the best sub-case by cosine similarity over cached embeddings.

    Falls back to the root case when no child clears ROUTING_MIN_SIM. If the best
    child is full, queues an expand_branch and writes to the root. If the best
    child has grandchildren, recurses one level.
    """
    children = get_child_cases(root_case_id)
    if not children:
        return root_case_id

    query_text = _findings_query_text(result).strip()
    if len(query_text) < 30:
        return root_case_id

    q_emb = _embed_text(query_text)
    if not q_emb:
        return root_case_id

    best_id = root_case_id
    best_sim = _ROUTING_MIN_SIM
    best_case = None
    for child in children:
        c_emb = _case_embedding(child)
        if not c_emb:
            continue
        sim = _cosine(q_emb, c_emb)
        if sim > best_sim:
            best_sim = sim
            best_id = child["id"]
            best_case = child

    if best_id == root_case_id or best_case is None:
        return root_case_id

    # Full sub-case → queue split and write to parent instead
    counts = get_case_counts(best_id)
    if counts["entity_count"] >= MAX_CASE_ENTITIES or counts["evidence_count"] >= MAX_CASE_EVIDENCE:
        print(f"[routing] Sub-case '{best_case['title']}' is full "
              f"({counts['entity_count']} entities, {counts['evidence_count']} evidence), writing to parent")
        enqueue_task(
            task_type="expand_branch",
            description=f"Sub-case full, needs splitting: {best_case['title']}",
            priority=3,
            case_id=best_id,
        )
        return root_case_id

    # Recurse one level if best child itself has children
    if get_child_cases(best_id):
        return _route_to_subcase(best_id, result)

    return best_id


def _write_findings_to_case(result: dict, task: dict):
    """Write investigation findings into the appropriate case, routing to sub-cases."""
    root_case_id = _map_case_branch(result, task)
    if not root_case_id:
        return

    # Route to the best sub-case
    case_id = _route_to_subcase(root_case_id, result)

    def _resolve_entity(name: str):
        """Resolve an entity name to a graph node with confidence gating.
        Returns a match dict if unambiguous, else None (and logs when skipped)."""
        matches = search_entities(name, limit=3, min_confidence=0.5)
        if not matches:
            return None
        # Reject matches where the runner-up is within 0.15 of the leader —
        # that's ambiguous and silently guessing pollutes case graphs.
        if len(matches) >= 2 and matches[1]["match_confidence"] >= matches[0]["match_confidence"] - 0.15:
            log_activity(
                action="ambiguous_entity",
                description=(
                    f"Skipped ambiguous entity '{name}': "
                    f"'{matches[0]['label']}' ({matches[0]['match_confidence']}) vs "
                    f"'{matches[1]['label']}' ({matches[1]['match_confidence']})"
                ),
                case_id=case_id,
            )
            return None
        return matches[0]

    # Add entities to case graph
    for entity in result.get("entities_found", []) + result.get("entities_involved", []):
        name = entity.get("name", "")
        if not name:
            continue
        match = _resolve_entity(name)
        if match:
            add_entity_to_case(case_id, match["id"], entity.get("role", ""))

    # Add connections as edges
    for conn in result.get("connections", []) + result.get("key_connections", []):
        source_name = conn.get("from") or conn.get("target", "")
        target_name = conn.get("to") or conn.get("target", "")
        if not source_name or not target_name:
            continue
        source_match = _resolve_entity(source_name)
        target_match = _resolve_entity(target_name)
        if source_match and target_match:
            add_edge_to_case(
                case_id,
                source_match["id"],
                target_match["id"],
                conn.get("relationship", "connected_to"),
            )

    # Add timeline events — require a source receipt (corpus refs or web grounding).
    global_sources = result.get("sources", [])
    is_web_grounded = bool(result.get("_web_grounded"))
    for event in result.get("timeline_events", []):
        if not event.get("title"):
            continue
        event_sources = event.get("sources")
        if not event_sources:
            if is_web_grounded and global_sources:
                event_sources = global_sources
            else:
                log_activity(
                    action="skipped_sourceless_event",
                    description=f"Skipped sourceless timeline event: {event['title'][:100]}",
                    case_id=case_id,
                )
                continue
        add_timeline_event(
            case_id,
            title=event["title"],
            event_date=event.get("date"),
            description=event.get("description", ""),
            category=event.get("category", "general"),
            sources=event_sources,
        )

    # Add intelligence note as evidence
    note = result.get("intelligence_note") or result.get("write_up") or result.get("intelligence_brief")
    if note:
        add_evidence(case_id, note, "investigation", global_sources)

    # Tag the task with the case it was routed to (enables linking back from UI)
    task_id = task.get("id")
    if task_id and case_id:
        try:
            sb = get_supabase()
            sb.table("agent_tasks").update({"case_id": case_id}).eq("id", task_id).execute()
        except Exception:
            pass  # non-critical


def _maybe_enqueue_bigger_picture():
    """Enqueue a Bigger Picture synthesis task if one isn't already queued."""
    try:
        sb = get_supabase()

        # Check if BP is paused
        status = sb.table("agent_status").select("bp_paused").eq("id", 1).execute()
        if status.data and status.data[0].get("bp_paused"):
            print("[agent] Bigger Picture is paused — skipping")
            return

        # Find the BP root case
        bp_res = sb.table("cases").select("id") \
            .eq("category", "bigger_picture") \
            .is_("parent_case_id", "null") \
            .limit(1).execute()
        if not bp_res.data:
            return
        bp_case_id = bp_res.data[0]["id"]

        # Check if there's already a queued or in_progress expand_branch for this case
        existing = sb.table("agent_tasks").select("id") \
            .eq("case_id", bp_case_id) \
            .eq("type", "expand_branch") \
            .in_("status", ["queued", "in_progress"]) \
            .limit(1).execute()
        if existing.data:
            return

        enqueue_task(
            task_type="expand_branch",
            description="Periodic cross-case synthesis: The Bigger Picture",
            priority=5,
            case_id=bp_case_id,
        )
        print("[agent] Enqueued periodic Bigger Picture synthesis")
    except Exception as e:
        print(f"[agent] Failed to enqueue Bigger Picture: {e}")


def execute_task(task: dict) -> dict:
    """Route a task to the appropriate strategy and execute it."""
    task_type = task.get("type", "")
    task_id = task.get("id", "unknown")

    log_activity(
        action="started_task",
        description=f"Starting {task_type}: {task.get('description', '')[:80]}",
        task_id=task_id,
        case_id=task.get("case_id"),
    )
    update_agent_status(current_task_id=task_id)

    try:
        if task_type == "validate_existing":
            result = validate_entity(task)
        elif task_type == "investigate_entity":
            result = entity_deep_dive(task)
        elif task_type == "test_theory":
            result = generate_and_test_theory(task)
        elif task_type == "explore_connection":
            result = explore_connection(task)
        elif task_type == "expand_branch":
            result = expand_branch(task)
        elif task_type == "user_directive":
            # User directives are treated as connection explorations with high priority
            result = explore_connection(task)
        else:
            result = {"error": f"Unknown task type: {task_type}"}

        # Write findings to case
        _write_findings_to_case(result, task)

        # Generate summary for task completion
        summary = result.get("summary") or result.get("function_analysis") or result.get("reasoning") or "Completed"
        if isinstance(summary, str) and len(summary) > 2000:
            summary = summary[:1997] + "..."

        complete_task(task_id, summary)
        update_agent_status(increment_completed=True)

        if task_type == "test_theory":
            update_agent_status(increment_theories=True)

        log_activity(
            action="completed_task",
            description=f"Completed {task_type}: {summary[:100]}",
            task_id=task_id,
            case_id=task.get("case_id"),
        )

        return result

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"[agent] Task {task_id} failed: {error_msg}")
        traceback.print_exc()
        fail_task(task_id, error_msg)
        log_activity(
            action="error",
            description=f"Task failed: {error_msg[:200]}",
            task_id=task_id,
            metadata={"error": error_msg},
        )
        return {"error": error_msg}


# ---------------------------------------------------------------------------
# Self-directed task generation
# ---------------------------------------------------------------------------

def generate_self_directed_task():
    """
    When the queue is empty, the agent generates its own next investigation.
    Looks at case branches and decides what to explore next.
    """
    root_cases = get_root_cases()
    if not root_cases:
        return None

    # Find the case branch with the least evidence (needs more work)
    sb = get_supabase()
    least_developed = None
    min_evidence = float("inf")

    for case in root_cases:
        evidence_count = sb.table("case_evidence").select("id", count="exact").eq("case_id", case["id"]).execute()
        count = evidence_count.count or 0
        if count < min_evidence:
            min_evidence = count
            least_developed = case

    if least_developed:
        return enqueue_task(
            task_type="expand_branch",
            description=f"Self-directed expansion of: {least_developed['title']}",
            priority=8,  # Lower priority than user directives
            case_id=least_developed["id"],
        )

    return None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run():
    """Main agent loop. Runs continuously until interrupted."""
    print("=" * 60)
    print("  LOCALWEBB AUTONOMOUS INVESTIGATION AGENT")
    print("=" * 60)
    print()

    # Initialize
    print("[agent] Initializing...")
    update_agent_status(is_running=True)

    # Seed root cases if needed
    print("[agent] Checking root cases...")
    seeded = seed_root_cases()
    if seeded:
        print(f"[agent] Created {seeded} root operational cases")

    # Seed initial tasks from graph
    print("[agent] Checking task queue...")
    seed_initial_tasks()

    stats = get_queue_stats()
    print(f"[agent] Queue: {stats['queued']} queued, {stats['completed']} completed, {stats['failed']} failed")
    print()
    print("[agent] Starting investigation loop (Ctrl+C to stop)")
    print("-" * 60)

    cycle = 0
    consecutive_errors = 0
    MAX_CONSECUTIVE_ERRORS = 10

    while _running:
        cycle += 1

        try:
            # Get next task
            task = next_task()

            if not task:
                # Queue empty — generate self-directed work
                print(f"\n[cycle {cycle}] Queue empty, generating self-directed task...")
                generated = generate_self_directed_task()
                if generated:
                    task = next_task()

            if not task:
                print(f"[cycle {cycle}] No tasks available, cooling down...")
                time.sleep(CYCLE_COOLDOWN)
                continue

            print(f"\n[cycle {cycle}] Task: {task['type']} — {task.get('description', '')[:80]}")

            # Execute
            result = execute_task(task)

            # Brief status
            stats = get_queue_stats()
            print(f"  Queue: {stats['queued']} queued | {stats['completed']} done | {stats['failed']} failed")

            # Reset error counter on success
            consecutive_errors = 0

            # Periodic Bigger Picture re-synthesis
            if cycle % BIGGER_PICTURE_INTERVAL == 0:
                _maybe_enqueue_bigger_picture()

        except KeyboardInterrupt:
            break
        except Exception as e:
            consecutive_errors += 1
            print(f"\n[cycle {cycle}] Unhandled error: {type(e).__name__}: {e}")
            traceback.print_exc()
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                print(f"[agent] {MAX_CONSECUTIVE_ERRORS} consecutive errors — shutting down")
                break
            backoff = min(CYCLE_COOLDOWN * consecutive_errors, 300)
            print(f"[agent] Backing off {backoff}s (error {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS})")
            time.sleep(backoff)
            continue

        # Cooldown between cycles
        if _running:
            print(f"  Cooling down {CYCLE_COOLDOWN}s...")
            time.sleep(CYCLE_COOLDOWN)

    # Shutdown
    print("\n[agent] Shutting down...")
    update_agent_status(is_running=False, current_task_id=None)
    print("[agent] Done.")


if __name__ == "__main__":
    run()

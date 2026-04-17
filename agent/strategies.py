"""
Investigation strategies — the analytical methods the agent uses.

Each strategy takes a task, researches it, and returns structured findings
that the agent loop writes into cases.
"""

import json
import re
import traceback

from google.genai import types

from agent.config import (
    get_genai, get_pinecone, get_supabase,
    PRIMARY_MODEL, FAST_MODEL, EMBEDDING_MODEL,
    SEMANTIC_FETCH_K, SEMANTIC_RERANK_TOP_N, SEMANTIC_RERANK_SHORTLIST,
    MAX_CHILD_TASKS_PER_CYCLE, THEORY_CONFIDENCE_COMMIT,
    MAX_SUBCASES_PER_PARENT,
    ITERATIVE_DEEPENING_MAX_ROUNDS, ITERATIVE_DEEPENING_CONFIDENCE_THRESHOLD,
    PRIOR_MEMORY_LIMIT,
)
from agent.memory import has_investigated, record_investigation, get_related_memories
from agent.queue import enqueue_task, parse_research_depth, get_research_depth
from agent.activity import log_activity
from agent.case_builder import find_or_create_subcase, get_child_cases, get_root_cases
from agent.web_research import (
    should_web_search, web_search, format_web_evidence, citations_as_sources,
)
from llm import generate


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# Max characters of an evidence chunk included in LLM prompts.
# 400-600 was truncating mid-sentence; gemini-2.5-pro handles 20x1200 trivially.
CHUNK_CHARS = 1200


def _semantic_search(
    query_text: str,
    top_k: int = SEMANTIC_RERANK_TOP_N,
    rerank: bool = True,
) -> list:
    """Run a semantic search against Pinecone.

    Returns list of {text, filename, page, score}, best-first.

    When `rerank` is True, the top SEMANTIC_RERANK_SHORTLIST Pinecone hits are
    re-ordered by a cheap FAST_MODEL call before truncating to `top_k`. This
    materially improves hit precision — Pinecone cosine is weak at intent.
    """
    genai = get_genai()
    pc = get_pinecone()

    # Embed
    res = genai.models.embed_content(model=EMBEDDING_MODEL, contents=[query_text])
    embedding = res.embeddings[0].values

    # Search
    results = pc.query(vector=embedding, top_k=SEMANTIC_FETCH_K, include_metadata=True)

    candidates = []
    for r in results.matches:
        if not r.metadata:
            continue
        text = ""
        if "_node_content" in r.metadata:
            try:
                node = json.loads(r.metadata["_node_content"])
                text = node.get("text", "")
            except (json.JSONDecodeError, TypeError):
                pass
        if not text:
            text = r.metadata.get("text", "")
        if text:
            candidates.append({
                "text": text,
                "filename": r.metadata.get("filename", "unknown"),
                "page": r.metadata.get("page", ""),
                "score": r.score,
            })

    if not candidates:
        return []

    shortlist = candidates[:SEMANTIC_RERANK_SHORTLIST] if SEMANTIC_RERANK_SHORTLIST > 0 else candidates
    if rerank and SEMANTIC_RERANK_SHORTLIST > 0 and len(shortlist) > top_k:
        shortlist = _llm_rerank(query_text, shortlist, keep=top_k)
    return shortlist[:top_k]


def _llm(prompt: str, model: str = None, json_mode: bool = False, purpose: str = "fast") -> str:
    """Quick LLM call. Returns text response.

    `purpose` selects a default model when `model` is not explicitly given:
      - "deep"    -> PRIMARY_MODEL (gemini-2.5-pro) for multi-hop synthesis
      - "fast" / "routing" / "rerank" -> FAST_MODEL (gemini-2.0-flash)

    If the deep model 503s / is rate-limited and no Groq fallback is configured,
    we downgrade to FAST_MODEL rather than failing the task. A degraded brief is
    better than a failed cycle.
    """
    genai = get_genai()
    config = None
    if json_mode:
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
        )
    chosen_model = model or (PRIMARY_MODEL if purpose == "deep" else FAST_MODEL)
    try:
        res = generate(genai, chosen_model, prompt, config=config)
        return res.text or ""
    except Exception as e:
        msg = f"{type(e).__name__}: {e}".lower()
        is_overload = any(k in msg for k in ("429", "resource_exhausted", "rate limit", "quota", "503", "unavailable", "overloaded"))
        if is_overload and chosen_model != FAST_MODEL:
            print(f"[llm] {chosen_model} overloaded, downgrading to {FAST_MODEL}")
            res = generate(genai, FAST_MODEL, prompt, config=config)
            return res.text or ""
        raise


def _llm_rerank(query_text: str, chunks: list, keep: int) -> list:
    """Re-rank Pinecone chunks by relevance to the query using FAST_MODEL.
    Falls back to original order on any error (rerank must never break search)."""
    if not chunks:
        return chunks
    try:
        numbered = "\n".join(
            f"[{i}] {c.get('text', '')[:300]}" for i, c in enumerate(chunks)
        )
        prompt = (
            "Rank the following evidence chunks by relevance to the QUERY.\n"
            "Return ONLY the most relevant indices, best-first, as JSON.\n\n"
            f"QUERY: {query_text}\n\n"
            f"CHUNKS:\n{numbered}\n\n"
            f"Respond in JSON: {{\"ranked_indices\": [<up to {keep} integer indices, best first>]}}"
        )
        resp = _llm(prompt, model=FAST_MODEL, json_mode=True, purpose="rerank")
        parsed = _extract_json_from_text(resp)
        indices = parsed.get("ranked_indices") or []
        seen = set()
        ordered = []
        for idx in indices:
            if isinstance(idx, int) and 0 <= idx < len(chunks) and idx not in seen:
                seen.add(idx)
                ordered.append(chunks[idx])
                if len(ordered) >= keep:
                    break
        # Append any remaining chunks the reranker didn't cover, preserving original order
        if len(ordered) < keep:
            for i, c in enumerate(chunks):
                if i not in seen:
                    ordered.append(c)
                    if len(ordered) >= keep:
                        break
        return ordered
    except Exception as e:
        print(f"[rerank] Failed, falling back to raw Pinecone order: {e}")
        return chunks


def _resolve_source_refs(event: dict, evidence_chunks: list) -> list:
    """Resolve source_refs indices from LLM output into actual source dicts."""
    refs = event.get("source_refs", [])
    if not refs:
        return []
    sources = []
    for idx in refs:
        if isinstance(idx, int) and 0 <= idx < len(evidence_chunks):
            c = evidence_chunks[idx]
            sources.append({"filename": c["filename"], "page": c["page"], "score": c["score"]})
    return sources


def _format_prior_memories(task: dict) -> str:
    """Render related agent_memory entries as a PRIOR INVESTIGATIONS block.
    Returns empty string if nothing relevant — safe to inline into any prompt."""
    description = (task or {}).get("description", "") or ""
    # Extract rough keywords (>3 chars, stripped of punctuation)
    raw = [w.strip(".,;:()[]\"'").lower() for w in description.split()]
    keywords = [w for w in raw if len(w) > 3][:10]
    try:
        memories = get_related_memories(
            case_id=(task or {}).get("case_id"),
            keywords=keywords,
            limit=PRIOR_MEMORY_LIMIT,
        )
    except Exception as e:
        print(f"[prior_memory] fetch failed: {e}")
        return ""
    if not memories:
        return ""
    lines = []
    for m in memories:
        mtype = m.get("memory_type") or "memory"
        content = (m.get("content") or "")[:180]
        outcome = (m.get("outcome") or "")[:120]
        lines.append(f"- [{mtype}] {content} — outcome: {outcome}")
    return (
        "PRIOR INVESTIGATIONS (outcomes of earlier agent work — treat as context, "
        "NOT as evidence. Do not re-derive; build on them):\n"
        + "\n".join(lines)
    )


def _deepen(
    first_pass: dict,
    task: dict,
    strategy_label: str,
    re_prompt_builder,
) -> dict:
    """Optional one-round iterative deepening.

    If the first-pass result has low confidence AND the LLM flagged gap_queries,
    run additional corpus (+ optional web) searches, then re-ask the LLM to
    refine its analysis. Merges timeline_events/connections additively.

    `re_prompt_builder(additional_evidence_block, first_pass) -> prompt` is a
    callable provided by the strategy, so prompt structure stays strategy-local.
    """
    if ITERATIVE_DEEPENING_MAX_ROUNDS <= 0:
        return first_pass
    gap_queries = [q for q in (first_pass.get("gap_queries") or []) if isinstance(q, str) and q.strip()]
    if not gap_queries:
        return first_pass
    confidence = first_pass.get("confidence")
    if isinstance(confidence, (int, float)) and confidence >= ITERATIVE_DEEPENING_CONFIDENCE_THRESHOLD:
        return first_pass

    # Pull fresh evidence for each gap query (cap total lookups)
    extra_chunks: list = []
    seen_keys: set = set()
    for gq in gap_queries[:3]:
        try:
            chunks = _semantic_search(gq, top_k=5, rerank=False)
        except Exception as e:
            print(f"[deepen] gap search failed for '{gq[:60]}': {e}")
            continue
        for c in chunks:
            key = f"{c.get('filename')}:{c.get('page')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            extra_chunks.append(c)

    # Optional web pass — reuse the selective policy against the combined corpus
    extra_web = {"used": False, "citations": []}
    if should_web_search(task, extra_chunks):
        # Stitch gap queries into one grounded query
        combined = " | ".join(gap_queries[:3])
        extra_web = web_search(combined, context=task.get("description", ""))

    if not extra_chunks and not extra_web.get("used"):
        return first_pass  # nothing new found — don't re-burn tokens

    extra_block_parts = []
    if extra_chunks:
        extra_block_parts.append(
            "ADDITIONAL CORPUS EVIDENCE FROM GAP QUERIES:\n"
            + "\n\n".join(
                f"[g{i}] [{c['filename']} p.{c['page']}]: {c['text'][:CHUNK_CHARS]}"
                for i, c in enumerate(extra_chunks[:12])
            )
        )
    if extra_web.get("used"):
        extra_block_parts.append(format_web_evidence(extra_web))
    extra_block = "\n\n".join(extra_block_parts)

    try:
        refine_prompt = re_prompt_builder(extra_block, first_pass)
        response = _llm(refine_prompt, json_mode=True, purpose="deep")
        refined = _extract_json_from_text(response)
    except Exception as e:
        print(f"[deepen] refine failed: {e}")
        return first_pass
    if not isinstance(refined, dict) or not refined:
        return first_pass

    # Merge — prefer refined values for long-form fields; union list fields.
    merged = dict(first_pass)
    for long_field in (
        "intelligence_note", "intelligence_brief", "write_up",
        "summary", "function_analysis", "reasoning",
    ):
        if refined.get(long_field):
            merged[long_field] = refined[long_field]
    for list_field in (
        "timeline_events", "connections", "key_connections",
        "entities_found", "entities_involved", "new_leads",
        "schemes_involved", "theories",
    ):
        combined = list(first_pass.get(list_field, []) or []) + list(refined.get(list_field, []) or [])
        # De-dup by title/name/text to avoid doubles
        seen = set()
        uniq = []
        for item in combined:
            if isinstance(item, dict):
                key = item.get("title") or item.get("name") or item.get("from") or json.dumps(item, sort_keys=True)[:120]
            else:
                key = str(item)[:120]
            if key in seen:
                continue
            seen.add(key)
            uniq.append(item)
        if uniq:
            merged[list_field] = uniq
    # Take the max confidence (refined analysis saw more evidence)
    old_c = first_pass.get("confidence")
    new_c = refined.get("confidence")
    try:
        cands = [c for c in (old_c, new_c) if isinstance(c, (int, float))]
        if cands:
            merged["confidence"] = max(cands)
    except Exception:
        pass
    # Resolve refined source_refs against the extra chunks too
    for event in merged.get("timeline_events", []):
        if not event.get("sources") and event.get("source_refs"):
            resolved = _resolve_source_refs(event, extra_chunks)
            if resolved:
                event["sources"] = resolved
    # Preserve / augment sources list with new web citations
    old_sources = list(first_pass.get("sources", []) or [])
    merged["sources"] = old_sources + citations_as_sources(extra_web)
    if extra_web.get("used"):
        merged["_web_grounded"] = True
    merged["_deepened"] = True
    log_activity(
        action="deepened",
        description=f"Iterative deepening applied to {strategy_label}: {len(extra_chunks)} new chunks, {len(extra_web.get('citations', []))} web",
        task_id=task.get("id"),
        case_id=task.get("case_id"),
    )
    return merged


def _extract_json_from_text(text: str) -> dict:
    """Robustly extract a JSON object from LLM output."""
    # Try to find a JSON object
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    # Try the whole text
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            return parsed[0]
    except json.JSONDecodeError:
        pass
    return {}


# ---------------------------------------------------------------------------
# Strategy A: Validate Existing Graph
# ---------------------------------------------------------------------------

def validate_entity(task: dict) -> dict:
    """
    Validate an existing entity in the knowledge graph.
    Checks if the entity description is accurate and edges are supported by evidence.
    Returns: {valid: bool, findings: str, corrections: [], new_leads: []}
    """
    _, cleaned = parse_research_depth(task.get("description", ""))
    entity_id = cleaned.strip()
    sb = get_supabase()

    # Fetch entity
    entity_res = sb.table("nodes").select("*").eq("id", entity_id).execute()
    if not entity_res.data:
        return {"valid": False, "findings": f"Entity {entity_id} not found", "corrections": [], "new_leads": []}

    entity = entity_res.data[0]
    label = entity.get("label", "Unknown")
    entity_type = entity.get("type", "UNKNOWN")
    description = entity.get("description", "")

    # Fetch edges for this entity
    edges_source = sb.table("edges").select("*").eq("source", entity_id).limit(20).execute()
    edges_target = sb.table("edges").select("*").eq("target", entity_id).limit(20).execute()
    all_edges = (edges_source.data or []) + (edges_target.data or [])

    # Search for evidence about this entity
    evidence_chunks = _semantic_search(f"{label} {entity_type} role involvement", top_k=8)
    evidence_text = "\n\n".join([f"[{c['filename']} p.{c['page']}]: {c['text'][:CHUNK_CHARS]}" for c in evidence_chunks])

    edge_descriptions = []
    for e in all_edges[:15]:
        edge_descriptions.append(
            f"- {e.get('source', '?')} --[{e.get('label', '?')}]--> {e.get('target', '?')}"
            f" (confidence: {e.get('confidence', '?')})"
        )
    edges_text = "\n".join(edge_descriptions) if edge_descriptions else "No edges found."

    prompt = f"""You are an intelligence analyst validating an entity in a knowledge graph about the Epstein network.

ENTITY:
- ID: {entity_id}
- Label: {label}
- Type: {entity_type}
- Current description: {description or 'None'}

KNOWN RELATIONSHIPS:
{edges_text}

DOCUMENT EVIDENCE:
{evidence_text}

Based on the evidence, analyze:
1. Is the entity description accurate? If not, what should it say?
2. What is this entity's FUNCTION in the network? (Don't just describe who they are — describe what role they played)
3. Which relationships are well-supported by evidence and which are speculative?
4. What new connections or leads should be investigated?

Respond in JSON:
{{
    "valid": true/false,
    "corrected_description": "...",
    "function_analysis": "2-3 sentences about the entity's operational role",
    "supported_edges": ["list of edge labels that have strong evidence"],
    "speculative_edges": ["list of edge labels that lack evidence"],
    "new_leads": ["list of new things to investigate based on findings"],
    "key_findings": "paragraph summarizing what we know and what questions remain"
}}"""

    response = _llm(prompt, json_mode=True)
    result = _extract_json_from_text(response)

    # Queue new leads as tasks
    for lead in result.get("new_leads", [])[:MAX_CHILD_TASKS_PER_CYCLE]:
        if not has_investigated("searched_query", lead):
            enqueue_task(
                task_type="explore_connection",
                description=lead,
                priority=6,
                case_id=task.get("case_id"),
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="validated_entity",
        description=f"Validated entity: {label} — {'valid' if result.get('valid') else 'needs correction'}",
        task_id=task.get("id"),
        entity_ids=[entity_id],
        metadata={"valid": result.get("valid", False)},
    )

    return result


# ---------------------------------------------------------------------------
# Strategy B: Entity Deep-Dive
# ---------------------------------------------------------------------------

def entity_deep_dive(task: dict) -> dict:
    """
    Deep investigation of an entity — its role, connections, timeline, and function.
    Returns structured findings to be written into cases.
    """
    depth, cleaned = parse_research_depth(task.get("description", ""))
    entity_query = cleaned.strip()
    sb = get_supabase()

    # Try to find the entity in the graph
    entity_results = (
        sb.table("nodes")
        .select("id, label, type, description, aliases")
        .ilike("label", f"%{entity_query}%")
        .limit(5)
        .execute()
    )

    entity_context = ""
    entity_ids = []
    if entity_results.data:
        for ent in entity_results.data:
            entity_ids.append(ent["id"])
            entity_context += f"\nGraph entity: {ent['label']} ({ent['type']})"
            if ent.get("description"):
                entity_context += f" — {ent['description'][:300]}"

        # Get edges for primary entity
        primary = entity_results.data[0]
        edges_s = sb.table("edges").select("*").eq("source", primary["id"]).limit(30).execute()
        edges_t = sb.table("edges").select("*").eq("target", primary["id"]).limit(30).execute()
        all_edges = (edges_s.data or []) + (edges_t.data or [])
        if all_edges:
            entity_context += "\n\nKnown relationships:"
            for e in all_edges[:20]:
                entity_context += f"\n- {e.get('source')} --[{e.get('label', 'related')}]--> {e.get('target')}"
                if e.get("evidence_text"):
                    entity_context += f" (evidence: {e['evidence_text'][:150]})"

    # Multi-angle semantic search
    search_angles = [
        f"{entity_query} role function involvement Epstein network",
        f"{entity_query} financial transactions money transfers",
        f"{entity_query} meetings travel connections associates",
        f"{entity_query} timeline events dates activities",
    ]

    all_evidence = []
    for angle in search_angles:
        chunks = _semantic_search(angle, top_k=5)
        all_evidence.extend(chunks)

    # Deduplicate by filename+page
    seen = set()
    unique_evidence = []
    for chunk in all_evidence:
        key = f"{chunk['filename']}:{chunk['page']}"
        if key not in seen:
            seen.add(key)
            unique_evidence.append(chunk)

    evidence_text = "\n\n".join([
        f"[{i}] [{c['filename']} p.{c['page']}]: {c['text'][:CHUNK_CHARS]}"
        for i, c in enumerate(unique_evidence[:20])
    ])

    # Hybrid / selective web search — gated by research_depth (shallow disables).
    web_result = {"used": False, "citations": []}
    if depth != "shallow" and should_web_search(task, unique_evidence):
        web_result = web_search(entity_query, context=entity_context)
        if web_result.get("used"):
            log_activity(
                action="web_searched",
                description=f"Web search: {entity_query[:80]} ({len(web_result.get('citations', []))} citations)",
                task_id=task.get("id"),
                case_id=task.get("case_id"),
            )
    web_block = format_web_evidence(web_result)
    prior_block = _format_prior_memories(task)

    prompt = f"""You are an intelligence analyst conducting a deep investigation into an entity connected to the Epstein network.

ENTITY TO INVESTIGATE: {entity_query}

EXISTING GRAPH KNOWLEDGE:
{entity_context or "No existing graph data found."}

{prior_block}

DOCUMENT EVIDENCE (numbered for source referencing):
{evidence_text}

{web_block}

Produce a comprehensive intelligence brief. Think about FUNCTION and MOTIVE, not just facts.
- What role did this entity play in the network?
- What operations were they involved in?
- Who did they connect and why?
- What's the timeline of their involvement?
- What schemes or operations does the evidence point to?
- What remains unknown and should be investigated?

Every timeline_event MUST include "source_refs" — zero-based indices into the DOCUMENT EVIDENCE chunks above that support each event. Events without source_refs will be discarded.

Respond in JSON:
{{
    "entity_name": "canonical name",
    "entity_type": "PERSON/ORGANIZATION/LOCATION/etc",
    "function_analysis": "2-4 sentences on their operational role in the network",
    "key_connections": [
        {{"target": "name", "relationship": "description", "evidence_strength": "strong/moderate/weak"}}
    ],
    "timeline_events": [
        {{"date": "YYYY-MM-DD or YYYY or approximate", "title": "event title", "description": "what happened", "category": "legal/financial/travel/social/other", "source_refs": [0, 2]}}
    ],
    "schemes_involved": ["list of operations/schemes this entity was part of"],
    "case_branches": ["which top-level operational questions this entity relates to"],
    "intelligence_brief": "3-5 paragraph analysis of this entity's role",
    "new_leads": ["specific things to investigate next"],
    "gap_queries": ["0-3 targeted follow-up search strings to fill gaps — leave empty if none"],
    "confidence": 0.0-1.0
}}"""

    response = _llm(prompt, json_mode=True, purpose="deep")
    result = _extract_json_from_text(response)

    # Build sources list — combine corpus chunks with web citations if we grounded.
    sources = [{"filename": c["filename"], "page": c["page"], "score": c["score"]} for c in unique_evidence[:10]]
    sources.extend(citations_as_sources(web_result))
    result["sources"] = sources
    result["entity_ids"] = entity_ids
    if web_result.get("used"):
        result["_web_grounded"] = True

    # One follow-up round if confidence is low and gaps were flagged.
    def _refine(extra_block: str, prev: dict) -> str:
        return f"""You previously produced an intelligence brief on "{entity_query}" based on a first pass of evidence. New evidence below may resolve gaps or change your analysis. Produce an updated, deeper brief in the SAME JSON shape as before — timeline_events still REQUIRE source_refs (now indices may refer to new evidence).

PREVIOUS BRIEF SUMMARY:
{(prev.get('function_analysis') or prev.get('intelligence_brief') or '')[:1500]}

PREVIOUSLY FLAGGED GAPS: {prev.get('gap_queries', [])}

{extra_block}

Respond in the same JSON shape (entity_name, entity_type, function_analysis, key_connections, timeline_events, schemes_involved, case_branches, intelligence_brief, new_leads, gap_queries, confidence)."""
    if depth != "shallow":
        result = _deepen(result, task, "entity_deep_dive", _refine)

    # Resolve per-event source references
    for event in result.get("timeline_events", []):
        resolved = _resolve_source_refs(event, unique_evidence)
        if resolved:
            event["sources"] = resolved

    # Queue new leads
    for lead in result.get("new_leads", [])[:MAX_CHILD_TASKS_PER_CYCLE]:
        if not has_investigated("searched_query", lead):
            enqueue_task(
                task_type="explore_connection",
                description=lead,
                priority=6,
                case_id=task.get("case_id"),
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="entity_deep_dive",
        description=f"Deep dive: {result.get('entity_name', entity_query)} — {result.get('function_analysis', '')[:100]}",
        task_id=task.get("id"),
        case_id=task.get("case_id"),
        entity_ids=entity_ids,
        metadata={"confidence": result.get("confidence", 0)},
    )

    return result


# ---------------------------------------------------------------------------
# Strategy C: Theory Generation & Testing
# ---------------------------------------------------------------------------

def generate_and_test_theory(task: dict) -> dict:
    """
    Generate a theory from a description/lead, then test it against evidence.
    Returns verdict and structured findings.
    """
    depth, cleaned = parse_research_depth(task.get("description", ""))
    lead = cleaned.strip()

    # First, formulate a testable theory from the lead
    theory_prompt = f"""You are an intelligence analyst investigating the Epstein network.
Based on this lead, formulate a specific, testable theory:

LEAD: {lead}

Respond in JSON:
{{
    "theory": "A specific, testable claim about the network (1-2 sentences)",
    "search_queries": ["3-4 specific queries to find supporting evidence"],
    "counter_queries": ["2-3 queries to find contradicting evidence"]
}}"""

    theory_raw = _llm(theory_prompt, json_mode=True)
    theory_data = _extract_json_from_text(theory_raw)
    theory = theory_data.get("theory", lead)

    if has_investigated("tested_theory", theory):
        return {"verdict": "already_tested", "theory": theory}

    # Search for supporting evidence
    supporting = []
    for query in theory_data.get("search_queries", [lead])[:4]:
        chunks = _semantic_search(query, top_k=5)
        supporting.extend(chunks)

    # Search for counter-evidence
    counter = []
    for query in theory_data.get("counter_queries", [f"NOT {lead}"])[:3]:
        chunks = _semantic_search(query, top_k=5)
        counter.extend(chunks)

    supporting_text = "\n\n".join([f"[{c['filename']} p.{c['page']}]: {c['text'][:CHUNK_CHARS]}" for c in supporting[:10]])
    counter_text = "\n\n".join([f"[{c['filename']} p.{c['page']}]: {c['text'][:800]}" for c in counter[:8]])

    # test_theory web-searches (per policy) unless shallow.
    web_result = {"used": False, "citations": []}
    combined_corpus = supporting + counter
    if depth != "shallow" and should_web_search(task, combined_corpus):
        web_result = web_search(theory, context=lead)
        if web_result.get("used"):
            log_activity(
                action="web_searched",
                description=f"Web search (theory): {theory[:80]} ({len(web_result.get('citations', []))} citations)",
                task_id=task.get("id"),
                case_id=task.get("case_id"),
            )
    web_block = format_web_evidence(web_result)
    prior_block = _format_prior_memories(task)

    verdict_prompt = f"""You are an intelligence analyst evaluating a theory about the Epstein network.
You must be rigorous and evidence-based. Do not speculate beyond what the evidence supports.

THEORY: {theory}

{prior_block}

SUPPORTING EVIDENCE:
{supporting_text or "No supporting evidence found."}

COUNTER-EVIDENCE:
{counter_text or "No counter-evidence found."}

{web_block}

Evaluate this theory. Consider:
- Does the evidence directly support the claim, or just circumstantially?
- Is there strong counter-evidence?
- What's the overall confidence level?

Respond in JSON:
{{
    "verdict": "supported/partially_supported/inconclusive/contradicted",
    "confidence": 0.0-1.0,
    "reasoning": "2-3 sentences explaining the verdict",
    "key_evidence": ["most important pieces of evidence"],
    "entities_involved": [{{"name": "...", "role": "their role in this theory"}}],
    "case_branch": "which operational question this relates to most",
    "new_leads": ["what should be investigated next based on this"],
    "gap_queries": ["0-3 targeted follow-up search strings if evidence was insufficient to rule for/against — empty if decisive"],
    "write_up": "A 2-3 paragraph intelligence note summarizing the theory and evidence"
}}"""

    verdict_raw = _llm(verdict_prompt, json_mode=True, purpose="deep")
    result = _extract_json_from_text(verdict_raw)
    result["theory"] = theory
    theory_sources = [{"filename": c["filename"], "page": c["page"], "score": c["score"]} for c in supporting[:8]]
    result["sources"] = theory_sources + citations_as_sources(web_result)
    if web_result.get("used"):
        result["_web_grounded"] = True

    # Follow-up round if confidence is low and gaps were flagged.
    def _refine(extra_block: str, prev: dict) -> str:
        return f"""You previously evaluated theory "{theory}". Additional evidence below. Re-evaluate and return the SAME JSON shape (verdict, confidence, reasoning, key_evidence, entities_involved, case_branch, new_leads, gap_queries, write_up).

PREVIOUS VERDICT: {prev.get('verdict')} (confidence {prev.get('confidence')})
PREVIOUS REASONING: {(prev.get('reasoning') or '')[:1000]}

PREVIOUSLY FLAGGED GAPS: {prev.get('gap_queries', [])}

{extra_block}

Respond in the same JSON shape."""
    if depth != "shallow":
        result = _deepen(result, task, "generate_and_test_theory", _refine)

    record_investigation("tested_theory", theory, result.get("verdict", "unknown"), task.get("case_id"))

    # Queue new leads
    for lead_item in result.get("new_leads", [])[:MAX_CHILD_TASKS_PER_CYCLE]:
        if not has_investigated("searched_query", lead_item):
            enqueue_task(
                task_type="explore_connection",
                description=lead_item,
                priority=5,
                case_id=task.get("case_id"),
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="tested_theory",
        description=f"Theory: \"{theory[:80]}...\" → {result.get('verdict', '?').upper()} ({int(result.get('confidence', 0)*100)}%)",
        task_id=task.get("id"),
        case_id=task.get("case_id"),
        metadata={"verdict": result.get("verdict"), "confidence": result.get("confidence")},
    )

    return result


# ---------------------------------------------------------------------------
# Strategy D: Connection Discovery
# ---------------------------------------------------------------------------

def explore_connection(task: dict) -> dict:
    """
    Explore a connection or lead — search for evidence and analyze it.
    This is the general-purpose investigation strategy.
    """
    depth, cleaned = parse_research_depth(task.get("description", ""))
    query = cleaned.strip()

    if has_investigated("searched_query", query):
        return {"status": "already_investigated", "query": query}

    # Corpus search
    chunks = _semantic_search(query, top_k=10)
    evidence_text = "\n\n".join([f"[{i}] [{c['filename']} p.{c['page']}]: {c['text'][:CHUNK_CHARS]}" for i, c in enumerate(chunks)])

    # Hybrid web search — gated by research_depth (shallow disables).
    web_result = {"used": False, "citations": []}
    if depth != "shallow" and should_web_search(task, chunks):
        web_result = web_search(query)
        if web_result.get("used"):
            log_activity(
                action="web_searched",
                description=f"Web search: {query[:80]} ({len(web_result.get('citations', []))} citations)",
                task_id=task.get("id"),
                case_id=task.get("case_id"),
            )

    if not evidence_text.strip() and not web_result.get("used"):
        record_investigation("searched_query", query, "no_evidence_found", task.get("case_id"))
        return {"status": "no_evidence", "query": query}

    web_block = format_web_evidence(web_result)
    prior_block = _format_prior_memories(task)

    prompt = f"""You are an intelligence analyst investigating the Epstein network.

INVESTIGATION QUERY: {query}

{prior_block}

DOCUMENT EVIDENCE (numbered for source referencing):
{evidence_text or "(no corpus hits for this query)"}

{web_block}

Analyze the evidence. What does it tell us about the network?
Think about FUNCTION — what was the purpose of this connection/activity?
Think about PATTERNS — does this connect to other known schemes?

Every timeline_event MUST include "source_refs" — zero-based indices into the DOCUMENT EVIDENCE chunks above that support each event. Events without source_refs will be discarded.

Respond in JSON:
{{
    "summary": "2-3 sentence summary of findings",
    "entities_found": [{{"name": "...", "type": "PERSON/ORG/etc", "role": "their function"}}],
    "connections": [{{"from": "...", "to": "...", "relationship": "...", "evidence_strength": "strong/moderate/weak"}}],
    "timeline_events": [{{"date": "...", "title": "...", "description": "...", "category": "...", "source_refs": [0, 2]}}],
    "case_branch": "which operational question this most relates to",
    "theories": ["testable hypotheses that emerge from this evidence"],
    "new_leads": ["specific next steps to investigate"],
    "intelligence_note": "1-2 paragraph write-up for the case file",
    "gap_queries": ["0-3 targeted follow-up search strings to fill gaps — leave empty if none"],
    "confidence": 0.0-1.0,
    "significance": "high/medium/low"
}}"""

    # User directives, and anything explicitly marked research_depth=deep,
    # warrant the deeper model. Shallow tasks always use FAST.
    is_deep = depth == "deep" or task.get("type") == "user_directive"
    if depth == "shallow":
        is_deep = False
    explore_purpose = "deep" if is_deep else "fast"
    response = _llm(prompt, json_mode=True, purpose=explore_purpose)
    result = _extract_json_from_text(response)
    corpus_sources = [{"filename": c["filename"], "page": c["page"], "score": c["score"]} for c in chunks[:8]]
    result["sources"] = corpus_sources + citations_as_sources(web_result)
    if web_result.get("used"):
        result["_web_grounded"] = True

    # Follow-up round gated by confidence + gap_queries (only for user_directive which used PRIMARY_MODEL)
    if explore_purpose == "deep":
        def _refine(extra_block: str, prev: dict) -> str:
            return f"""You previously analyzed the query "{query}" and produced a first-pass summary. Additional evidence below. Produce an updated analysis in the SAME JSON shape (summary, entities_found, connections, timeline_events, case_branch, theories, new_leads, intelligence_note, gap_queries, confidence, significance). timeline_events still REQUIRE source_refs.

PREVIOUS SUMMARY:
{(prev.get('summary') or prev.get('intelligence_note') or '')[:1500]}

PREVIOUSLY FLAGGED GAPS: {prev.get('gap_queries', [])}

{extra_block}

Respond in the same JSON shape."""
        result = _deepen(result, task, "explore_connection", _refine)

    # Resolve per-event source references
    for event in result.get("timeline_events", []):
        resolved = _resolve_source_refs(event, chunks)
        if resolved:
            event["sources"] = resolved

    record_investigation("searched_query", query, result.get("summary", "investigated"), task.get("case_id"))

    # Queue theories for testing
    for theory in result.get("theories", [])[:2]:
        if not has_investigated("tested_theory", theory):
            enqueue_task(
                task_type="test_theory",
                description=theory,
                priority=5,
                case_id=task.get("case_id"),
                parent_task_id=task.get("id"),
            )

    # Queue new leads
    for lead_item in result.get("new_leads", [])[:MAX_CHILD_TASKS_PER_CYCLE]:
        if not has_investigated("searched_query", lead_item):
            enqueue_task(
                task_type="explore_connection",
                description=lead_item,
                priority=7,
                case_id=task.get("case_id"),
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="explored_connection",
        description=f"Explored: {query[:80]} — {result.get('significance', '?')} significance",
        task_id=task.get("id"),
        case_id=task.get("case_id"),
        metadata={"significance": result.get("significance")},
    )

    return result


# ---------------------------------------------------------------------------
# Strategy E: Expand Branch (generate new tasks for a case branch)
# ---------------------------------------------------------------------------

def expand_branch(task: dict) -> dict:
    """
    Look at an existing case branch and decide what to investigate next.
    Uses the case's current state to identify gaps and new angles.
    """
    case_id = task.get("case_id")
    if not case_id:
        return {"error": "No case_id provided"}

    sb = get_supabase()

    # Get case info
    case_res = sb.table("cases").select("*").eq("id", case_id).execute()
    if not case_res.data:
        return {"error": f"Case {case_id} not found"}
    case = case_res.data[0]

    # Bigger Picture cases use cross-case synthesis instead of normal expansion
    if case.get("category") == "bigger_picture":
        return _bigger_picture_expansion(case, task)

    # Get existing evidence
    evidence_res = sb.table("case_evidence").select("content, type").eq("case_id", case_id).limit(20).execute()
    evidence_summaries = [e["content"][:200] for e in (evidence_res.data or [])]

    # Get case entities
    entities_res = sb.table("case_graph_entities").select("node_id").eq("case_id", case_id).execute()
    entity_ids = [e["node_id"] for e in (entities_res.data or [])]

    # Get child cases
    children = sb.table("cases").select("title, summary").eq("parent_case_id", case_id).execute()
    child_summaries = [f"- {c['title']}: {(c.get('summary') or '')[:100]}" for c in (children.data or [])]

    prompt = f"""You are an intelligence analyst reviewing a case branch in the Epstein network investigation.

CASE: {case['title']}
OPERATIONAL QUESTION: {case.get('operational_question', 'N/A')}
SUMMARY: {case.get('summary', 'No summary yet')}

EXISTING EVIDENCE ({len(evidence_summaries)} items):
{chr(10).join(evidence_summaries[:10]) or "None yet"}

ENTITIES ON CASE GRAPH: {', '.join(entity_ids[:20]) or "None yet"}

SUB-CASES:
{chr(10).join(child_summaries) or "None yet"}

Based on the current state, identify:
1. What gaps exist in our understanding?
2. What entities should we investigate deeper?
3. What theories should we test?
4. Should we create any new sub-cases?

Respond in JSON:
{{
    "gaps": ["list of gaps in knowledge"],
    "entity_investigations": ["entities to deep-dive"],
    "theories_to_test": ["specific testable theories"],
    "new_subcases": [{{"title": "...", "summary": "why this merits its own sub-case"}}],
    "priority_actions": ["top 3 most important next steps"]
}}"""

    response = _llm(prompt, json_mode=True)
    result = _extract_json_from_text(response)

    # Create sub-cases (respect cap)
    existing_children = get_child_cases(case_id)
    slots_remaining = max(0, MAX_SUBCASES_PER_PARENT - len(existing_children))
    created_subcases = []
    for sc in result.get("new_subcases", [])[:slots_remaining]:
        title = sc.get("title", "").strip()
        if not title:
            continue
        subcase = find_or_create_subcase(
            parent_case_id=case_id,
            title=title,
            category=case.get("category", "other"),
            summary=sc.get("summary", ""),
        )
        created_subcases.append(subcase)
        enqueue_task(
            task_type="expand_branch",
            description=f"Investigate sub-case: {title}",
            priority=4,
            case_id=subcase["id"],
            parent_task_id=task.get("id"),
        )

    # Embedding-based routing for child tasks — reuses the agent's cached
    # sub-case embeddings so we only embed each case once per process.
    all_children = existing_children + created_subcases
    from agent.autonomous_agent import _case_embedding, _embed_text, _cosine
    _ROUTING_MIN_SIM_LOCAL = 0.40  # slightly looser for short entity/theory text

    def _best_subcase_for(text: str) -> str:
        """Pick the best child sub-case by cosine similarity, or fall back to parent."""
        if not all_children or not text:
            return case_id
        q_emb = _embed_text(text)
        if not q_emb:
            return case_id
        best_id, best_sim = case_id, _ROUTING_MIN_SIM_LOCAL
        for child in all_children:
            c_emb = _case_embedding(child)
            if not c_emb:
                continue
            sim = _cosine(q_emb, c_emb)
            if sim > best_sim:
                best_sim = sim
                best_id = child["id"]
        return best_id

    # Queue entity investigations — route to best matching sub-case
    for entity in result.get("entity_investigations", [])[:3]:
        if not has_investigated("investigated_entity", entity):
            enqueue_task(
                task_type="investigate_entity",
                description=entity,
                priority=4,
                case_id=_best_subcase_for(entity),
                parent_task_id=task.get("id"),
            )

    # Queue theories — route to best matching sub-case
    for theory in result.get("theories_to_test", [])[:3]:
        if not has_investigated("tested_theory", theory):
            enqueue_task(
                task_type="test_theory",
                description=theory,
                priority=5,
                case_id=_best_subcase_for(theory),
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="expanded_branch",
        description=f"Expanded case: {case['title']} — {len(result.get('new_subcases', []))} sub-cases, {len(result.get('gaps', []))} gaps",
        task_id=task.get("id"),
        case_id=case_id,
    )

    return result


# ---------------------------------------------------------------------------
# Bigger Picture: cross-case synthesis
# ---------------------------------------------------------------------------

def _bigger_picture_expansion(case: dict, task: dict) -> dict:
    """
    Instead of expanding a single branch, synthesize findings across ALL root
    cases to identify cross-case patterns, connections, and contradictions.
    Returns the same shape as expand_branch so the caller can create sub-cases
    and enqueue follow-up tasks normally.
    """
    sb = get_supabase()
    case_id = case["id"]

    # Gather all root cases except The Bigger Picture itself
    root_cases = [c for c in get_root_cases() if c["id"] != case_id]
    if not root_cases:
        return {"error": "No other root cases to synthesize"}

    # Build per-case summaries with recent evidence
    case_briefs = []
    for rc in root_cases[:10]:
        ev_res = sb.table("case_evidence").select("content, type, created_at") \
            .eq("case_id", rc["id"]).order("created_at", desc=True).limit(5).execute()
        evidence_snippets = []
        for e in (ev_res.data or []):
            evidence_snippets.append(f"  [{e['type']}] {e['content'][:400]}")

        entities_res = sb.table("case_graph_entities").select("node_id") \
            .eq("case_id", rc["id"]).execute()
        entity_ids = [e["node_id"] for e in (entities_res.data or [])]

        child_res = sb.table("cases").select("title, summary") \
            .eq("parent_case_id", rc["id"]).execute()
        subcases = [f"    - {c['title']}: {(c.get('summary') or '')[:100]}" for c in (child_res.data or [])]

        brief = f"""CASE: {rc['title']}
CATEGORY: {rc.get('category', 'other')}
OPERATIONAL QUESTION: {rc.get('operational_question', 'N/A')}
SUMMARY: {rc.get('summary', 'No summary yet')}
ENTITIES ({len(entity_ids)}): {', '.join(entity_ids[:15])}
SUB-CASES:
{chr(10).join(subcases) or '  None yet'}
RECENT EVIDENCE ({len(ev_res.data or [])} items):
{chr(10).join(evidence_snippets) or '  None yet'}"""
        case_briefs.append(brief)

    prompt = f"""You are a Lead Intelligence Analyst overseeing multiple parallel investigations into the Epstein network. Your task is to perform a CROSS-CASE SYNTHESIS — stepping back from individual cases to identify the bigger picture.

ACTIVE INVESTIGATIONS:
{'=' * 60}
{(chr(10) + '=' * 60 + chr(10)).join(case_briefs)}
{'=' * 60}

Analyze ALL cases together and identify:

1. CROSS-CASE CONNECTIONS: Entities, financial flows, or patterns that appear across multiple cases. Which cases are converging on the same actors or mechanisms?
2. EMERGENT NARRATIVE: What story emerges when you view all investigations together that isn't visible from any single case?
3. CONTRADICTIONS: Where do findings in one case contradict or complicate findings in another?
4. KNOWLEDGE GAPS: Critical questions that span multiple cases and haven't been answered yet.
5. PRIORITY RECOMMENDATIONS: Based on the cross-case view, which leads or entities deserve the most urgent attention?

Respond in JSON:
{{
    "intelligence_note": "A 3-5 paragraph narrative synthesis (the 'bigger picture' story)",
    "cross_case_connections": ["entity or pattern that spans multiple cases"],
    "contradictions": ["contradiction between cases"],
    "gaps": ["critical unanswered questions spanning cases"],
    "entity_investigations": ["entities that appear in multiple cases and need deeper investigation"],
    "theories_to_test": ["cross-case theories worth testing"],
    "new_subcases": [{{"title": "...", "summary": "why this cross-case angle merits its own sub-case"}}],
    "priority_actions": ["top 3 most important next steps"]
}}"""

    response = _llm(prompt, json_mode=True, purpose="deep")
    result = _extract_json_from_text(response)

    # Save the narrative synthesis as evidence on the Bigger Picture case
    intelligence_note = result.get("intelligence_note", "")
    if intelligence_note:
        cross_connections = result.get("cross_case_connections", [])
        contradictions = result.get("contradictions", [])
        gaps = result.get("gaps", [])

        content = f"""# Cross-Case Intelligence Synthesis

{intelligence_note}

## Cross-Case Connections
{chr(10).join(f'- {c}' for c in cross_connections) or 'None identified'}

## Contradictions & Anomalies
{chr(10).join(f'- {c}' for c in contradictions) or 'None identified'}

## Knowledge Gaps
{chr(10).join(f'- {g}' for g in gaps) or 'None identified'}

## Priority Actions
{chr(10).join(f'- {a}' for a in result.get('priority_actions', [])) or 'None'}"""

        sb.table("case_evidence").insert({
            "case_id": case_id,
            "type": "fact_check",
            "content": content,
            "sources": [],
        }).execute()

    # Create sub-cases and enqueue tasks — reuse expand_branch's machinery
    existing_children = get_child_cases(case_id)
    slots_remaining = max(0, MAX_SUBCASES_PER_PARENT - len(existing_children))
    for sc in result.get("new_subcases", [])[:slots_remaining]:
        title = sc.get("title", "").strip()
        if not title:
            continue
        subcase = find_or_create_subcase(
            parent_case_id=case_id,
            title=title,
            category="bigger_picture",
            summary=sc.get("summary", ""),
        )
        enqueue_task(
            task_type="expand_branch",
            description=f"Investigate cross-case angle: {title}",
            priority=3,
            case_id=subcase["id"],
            parent_task_id=task.get("id"),
        )

    # Queue entity investigations
    for entity in result.get("entity_investigations", [])[:3]:
        if not has_investigated("investigated_entity", entity):
            enqueue_task(
                task_type="investigate_entity",
                description=entity,
                priority=3,
                case_id=case_id,
                parent_task_id=task.get("id"),
            )

    # Queue cross-case theories
    for theory in result.get("theories_to_test", [])[:3]:
        if not has_investigated("tested_theory", theory):
            enqueue_task(
                task_type="test_theory",
                description=theory,
                priority=4,
                case_id=case_id,
                parent_task_id=task.get("id"),
            )

    log_activity(
        action="bigger_picture_synthesis",
        description=f"Cross-case synthesis: {len(result.get('cross_case_connections', []))} connections, {len(result.get('contradictions', []))} contradictions, {len(result.get('gaps', []))} gaps",
        task_id=task.get("id"),
        case_id=case_id,
    )

    return result

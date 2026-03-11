"""
Theory Investigation Pipeline.
Tests a user's theory against the evidence corpus with explicit anti-bias measures.
Yields SSE events as it progresses through phases:
  T-A) Theory Decomposition
  T-B) Entity Intel
  T-C) Graph Traversal
  T-D) Supporting Evidence Search
  T-E) Counter-Evidence Search
  T-F) Cross-Reference Cases (conditional)
  T-G) Verdict Synthesis (streamed)
"""

import json
import queue as _queue
import traceback
import asyncio
import re
from typing import AsyncGenerator

from google.genai import types

try:
    from api.llm import generate, generate_stream
except ImportError:
    from llm import generate, generate_stream


def _sse(event_type: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event_type, **data})}\n\n"


def _extract_json(text: str) -> str:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        return match.group(0)
    return text


def _truncate_at_sentence(text: str, max_len: int = 1200) -> str:
    if len(text) <= max_len:
        return text
    truncated = text[:max_len]
    last_period = truncated.rfind('.')
    last_newline = truncated.rfind('\n')
    boundary = max(last_period, last_newline)
    if boundary > max_len // 2:
        return truncated[:boundary + 1]
    return truncated


def _safe_semantic_pass(semantic_search_fn, query_text, genai_client, pinecone_index,
                        rerank_fn=None, fetch_k=50, rerank_top_n=5, pinecone_filter=None):
    try:
        return semantic_search_fn(
            query_text=query_text,
            genai_client=genai_client,
            pinecone_index=pinecone_index,
            rerank_fn=rerank_fn,
            fetch_k=fetch_k,
            rerank_top_n=rerank_top_n,
            pinecone_filter=pinecone_filter,
        ), None
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        print(f"DEBUG: Semantic pass failed: {err}")
        return [], err


async def run_theory_investigation(
    theory: str,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
    cross_ref_cases: list = None,
) -> AsyncGenerator[str, None]:
    try:
        async for event in _run_theory_inner(
            theory, genai_client, pinecone_index, supabase_client,
            semantic_search_fn, rerank_fn, cross_ref_cases,
        ):
            yield event
    except Exception as e:
        tb = traceback.format_exc()
        print(f"CRITICAL: Theory pipeline crashed: {tb}")
        yield _sse("text", {"text": f"\n\n**Pipeline error:** {type(e).__name__}: {e}"})
        yield _sse("done", {})


async def _run_theory_inner(
    theory: str,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
    cross_ref_cases: list = None,
) -> AsyncGenerator[str, None]:
    supporting_chunks = []
    contradicting_chunks = []
    all_sources = []
    seen_texts = set()
    entity_intels = {}
    graph_evidence = []
    errors_log = []

    def _add_chunk(chunk, direction):
        if not isinstance(chunk, dict) or "text" not in chunk:
            return
        sig = re.sub(r'\s+', ' ', chunk["text"][:500]).strip()
        if sig not in seen_texts:
            seen_texts.add(sig)
            chunk["direction"] = direction
            if direction == "supporting":
                supporting_chunks.append(chunk)
            else:
                contradicting_chunks.append(chunk)

    # -------------------------------------------------------------------
    # Phase T-A: Theory Decomposition
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "theory_decomposition", "label": "Decomposing Theory", "status": "running"})
    await asyncio.sleep(0.1)

    cross_ref_context = ""
    if cross_ref_cases:
        parts = ["EXISTING CASE CONTEXT (use as additional investigative context):"]
        for case in cross_ref_cases[:5]:
            parts.append(f"- Case: {case.get('title', 'Untitled')}")
            parts.append(f"  Summary: {case.get('summary', 'N/A')}")
            if case.get("entities"):
                parts.append(f"  Entities: {', '.join(case['entities'][:10])}")
            if case.get("evidence_texts"):
                for et in case["evidence_texts"][:3]:
                    parts.append(f"  Evidence excerpt: {et[:300]}")
        cross_ref_context = "\n".join(parts)

    decomposition_prompt = (
        "You are an investigative analyst trained in critical thinking and hypothesis testing.\n"
        "Decompose a theory into testable claims, then identify what evidence would SUPPORT "
        "each claim and what evidence would CONTRADICT or DISPROVE each claim.\n\n"
        f"THEORY: {theory}\n\n"
        f"{cross_ref_context}\n\n" if cross_ref_context else
        "You are an investigative analyst trained in critical thinking and hypothesis testing.\n"
        "Decompose a theory into testable claims, then identify what evidence would SUPPORT "
        "each claim and what evidence would CONTRADICT or DISPROVE each claim.\n\n"
        f"THEORY: {theory}\n\n"
    )
    decomposition_prompt += (
        "Return JSON with:\n"
        '1. "claims": array of objects with:\n'
        '   - "claim_text": specific testable assertion\n'
        '   - "entities_involved": named persons/orgs/locations (array of strings)\n'
        '   - "supporting_search_queries": 2-3 queries to find evidence FOR this claim\n'
        '   - "contradicting_search_queries": 2-3 queries to find evidence AGAINST this claim\n'
        '   - "key_terms": keywords for document retrieval\n'
        '2. "primary_entities": all specific named entities from the theory\n'
        '3. "implicit_assumptions": unstated assumptions the theory relies on that could be wrong\n'
        '4. "null_hypothesis": what would be true if this theory is wrong\n\n'
        "RULES:\n"
        "- Every claim must be specific and falsifiable\n"
        '- "contradicting_search_queries" MUST genuinely seek disconfirming evidence, not strawmen\n'
        '- "entities_involved" must be specific named entities, NOT generic words\n'
        '- "primary_entities" must ONLY include entities explicitly named or directly implied in the theory text. '
        'Do NOT invent or assume additional entities. If the theory says "Israel funded Trump through Phunware", '
        'the primary entities are Israel (or Israeli government), Trump (or Trump campaign), and Phunware — nothing else.\n'
        "- Think like a defense attorney poking holes in each claim\n\n"
        "Return JSON only."
    )

    analysis = None
    try:
        analysis_res = await asyncio.to_thread(
            generate, genai_client, model="gemini-2.0-flash",
            contents=decomposition_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        analysis = json.loads(_extract_json(analysis_res.text))
        claims = analysis.get("claims", [])[:5]
        primary_entities = analysis.get("primary_entities", [])[:5]
        null_hypothesis = analysis.get("null_hypothesis", "")
        implicit_assumptions = analysis.get("implicit_assumptions", [])

        detail = f"{len(claims)} claims, {len(primary_entities)} entities"
        yield _sse("step_status", {"step": "theory_decomposition", "label": "Decomposing Theory", "status": "done", "detail": detail})
    except Exception as e:
        print(f"DEBUG: Theory decomposition failed: {e}")
        errors_log.append(f"Theory Decomposition: {type(e).__name__}")
        claims = []
        primary_entities = []
        null_hypothesis = ""
        implicit_assumptions = []
        # Fallback: treat theory as a single claim
        claims = [{"claim_text": theory, "entities_involved": [], "supporting_search_queries": [theory], "contradicting_search_queries": [], "key_terms": theory.split()[:5]}]
        yield _sse("step_status", {"step": "theory_decomposition", "label": "Decomposing Theory", "status": "error", "detail": "Using fallback"})

    await asyncio.sleep(0.3)

    # -------------------------------------------------------------------
    # Phase T-B: Entity Intel
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "running"})
    await asyncio.sleep(0.1)

    try:
        from api.graph_ops import lookup_entity_intel
    except ImportError:
        from graph_ops import lookup_entity_intel

    # Also collect entities from claims
    all_entity_names = list(primary_entities)
    for claim in claims:
        for ent in claim.get("entities_involved", []):
            if ent not in all_entity_names:
                all_entity_names.append(ent)
    all_entity_names = all_entity_names[:8]

    found_count = 0
    for name in all_entity_names:
        try:
            intel = await asyncio.to_thread(lookup_entity_intel, supabase_client, name)
            if intel.get("found"):
                entity_intels[name] = intel
                found_count += 1
        except Exception as e:
            errors_log.append(f"Entity Intel ({name}): {type(e).__name__}")

    yield _sse("step_status", {
        "step": "entity_intel", "label": "Entity Intelligence", "status": "done",
        "detail": f"{found_count}/{len(all_entity_names)} entities found",
    })
    await asyncio.sleep(0.3)

    # Build classified entity suggestions with relevance filtering
    raw_entity_suggestions = []
    for name in all_entity_names:
        intel = entity_intels.get(name)
        if intel and intel.get("found"):
            raw_entity_suggestions.append({
                "name": intel.get("entity_name", name),
                "id": intel.get("entity_id"),
                "type": intel.get("entity_type", "UNKNOWN"),
                "on_graph": True,
                "edge_count": intel.get("edge_count", 0),
            })
        else:
            raw_entity_suggestions.append({
                "name": name,
                "id": None,
                "type": "UNKNOWN",
                "on_graph": False,
                "edge_count": 0,
            })

    # Relevance filter: ask LLM which entities are actually relevant to the theory
    entity_suggestions = raw_entity_suggestions
    if len(raw_entity_suggestions) > 0:
        try:
            entity_names_list = [e["name"] for e in raw_entity_suggestions]
            relevance_prompt = (
                "You are filtering a list of entities for relevance to a specific theory.\n"
                "ONLY keep entities that are directly relevant to testing this theory — "
                "meaning they are mentioned in the theory, are a known participant in the alleged activity, "
                "or there is a documented evidential connection to the claims.\n\n"
                "Do NOT include entities just because they exist in a database or share a loose association. "
                "If an entity is not clearly connected to the theory's specific claims, exclude it.\n\n"
                f"THEORY: {theory}\n\n"
                f"CLAIMS:\n" + "\n".join(f"- {c.get('claim_text', '')}" for c in claims) + "\n\n"
                f"ENTITIES TO EVALUATE: {json.dumps(entity_names_list)}\n\n"
                'Return JSON: {"relevant": ["entity1", "entity2", ...]} — only the names that pass the filter.\n'
                "Return JSON only."
            )
            rel_res = await asyncio.to_thread(
                generate, genai_client, model="gemini-2.0-flash",
                contents=relevance_prompt,
                config=types.GenerateContentConfig(response_mime_type="application/json"),
            )
            rel_data = json.loads(_extract_json(rel_res.text))
            relevant_names = set(n.lower() for n in rel_data.get("relevant", []))
            if relevant_names:
                entity_suggestions = [e for e in raw_entity_suggestions if e["name"].lower() in relevant_names]
                # Always keep entities explicitly in the theory text
                theory_lower = theory.lower()
                for e in raw_entity_suggestions:
                    if e["name"].lower() in theory_lower and e not in entity_suggestions:
                        entity_suggestions.append(e)
        except Exception as e:
            print(f"DEBUG: Entity relevance filter failed: {e}")
            # Fall back to unfiltered list
            entity_suggestions = raw_entity_suggestions

    # -------------------------------------------------------------------
    # Phase T-C: Graph Traversal
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "running"})
    await asyncio.sleep(0.1)

    try:
        from api.graph_ops import bfs_collect_evidence
    except ImportError:
        from graph_ops import bfs_collect_evidence

    seen_edge_ids = set()
    for name, intel in entity_intels.items():
        try:
            edges = await asyncio.to_thread(
                bfs_collect_evidence, supabase_client, intel["entity_id"], max_hops=2, max_edges=30
            )
            for edge in edges:
                eid = edge.get("id", f"{edge.get('source')}-{edge.get('target')}")
                if eid not in seen_edge_ids:
                    seen_edge_ids.add(eid)
                    graph_evidence.append(edge)
        except Exception as e:
            errors_log.append(f"Graph Traversal ({name}): {type(e).__name__}")

    yield _sse("step_status", {
        "step": "graph_traversal", "label": "Graph Traversal", "status": "done",
        "detail": f"{len(graph_evidence)} edges from {len(entity_intels)} entities",
    })
    await asyncio.sleep(0.3)

    # -------------------------------------------------------------------
    # Phase T-D: Supporting Evidence Search
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "supporting_search", "label": "Supporting Evidence", "status": "running"})
    await asyncio.sleep(0.1)

    sup_pass_count = 0
    sup_errors = []

    for i, claim in enumerate(claims[:3]):
        for query in claim.get("supporting_search_queries", [])[:2]:
            results, err = await asyncio.to_thread(
                _safe_semantic_pass, semantic_search_fn, query, genai_client, pinecone_index,
                rerank_fn=rerank_fn, fetch_k=50, rerank_top_n=5,
            )
            if err:
                sup_errors.append(err)
            else:
                for r in results:
                    _add_chunk(r, "supporting")
                sup_pass_count += 1

            yield _sse("step_status", {"step": "supporting_search", "label": "Supporting Evidence", "status": "running",
                        "detail": f"{sup_pass_count} passes, {len(supporting_chunks)} chunks"})
            await asyncio.sleep(0.1)

    # Keyword search for entities
    try:
        from api.graph_ops import keyword_search_evidence
    except ImportError:
        from graph_ops import keyword_search_evidence

    entity_names_for_kw = [n for n in all_entity_names if len(n) > 2][:5]
    if entity_names_for_kw and supabase_client:
        try:
            kw_results = await asyncio.to_thread(keyword_search_evidence, supabase_client, entity_names_for_kw, limit=10)
            for edge in kw_results:
                if edge.get("evidence_text"):
                    _add_chunk({"text": edge["evidence_text"], "filename": edge.get("source_filename", "graph"), "page": edge.get("source_page", "?"), "score": 0}, "supporting")
        except Exception as e:
            errors_log.append(f"Keyword Search: {type(e).__name__}")

    if sup_errors:
        errors_log.append(f"Supporting Search: {len(sup_errors)} pass(es) failed")

    yield _sse("step_status", {
        "step": "supporting_search", "label": "Supporting Evidence", "status": "done",
        "detail": f"{sup_pass_count} passes, {len(supporting_chunks)} chunks",
    })
    await asyncio.sleep(0.3)

    # -------------------------------------------------------------------
    # Phase T-E: Counter-Evidence Search
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "counter_search", "label": "Counter-Evidence", "status": "running"})
    await asyncio.sleep(0.1)

    counter_pass_count = 0
    counter_errors = []

    for i, claim in enumerate(claims[:3]):
        for query in claim.get("contradicting_search_queries", [])[:2]:
            results, err = await asyncio.to_thread(
                _safe_semantic_pass, semantic_search_fn, query, genai_client, pinecone_index,
                rerank_fn=rerank_fn, fetch_k=50, rerank_top_n=5,
            )
            if err:
                counter_errors.append(err)
            else:
                for r in results:
                    _add_chunk(r, "contradicting")
                counter_pass_count += 1

            yield _sse("step_status", {"step": "counter_search", "label": "Counter-Evidence", "status": "running",
                        "detail": f"{counter_pass_count} passes, {len(contradicting_chunks)} chunks"})
            await asyncio.sleep(0.1)

    # Adversarial search with null hypothesis
    if null_hypothesis:
        entity_str = " ".join(all_entity_names[:3])
        adversarial_query = f"{null_hypothesis} evidence against {entity_str}"
        results, err = await asyncio.to_thread(
            _safe_semantic_pass, semantic_search_fn, adversarial_query, genai_client, pinecone_index,
            rerank_fn=rerank_fn, fetch_k=40, rerank_top_n=5,
        )
        if not err:
            for r in results:
                _add_chunk(r, "contradicting")
            counter_pass_count += 1

    if counter_errors:
        errors_log.append(f"Counter Search: {len(counter_errors)} pass(es) failed")

    yield _sse("step_status", {
        "step": "counter_search", "label": "Counter-Evidence", "status": "done",
        "detail": f"{counter_pass_count} passes, {len(contradicting_chunks)} chunks",
    })
    await asyncio.sleep(0.3)

    # -------------------------------------------------------------------
    # Phase T-F: Cross-Reference Cases
    # -------------------------------------------------------------------
    if cross_ref_cases:
        yield _sse("step_status", {"step": "case_crossref", "label": "Case Cross-Reference", "status": "running"})
        await asyncio.sleep(0.1)
        cross_ref_context_text = ""
        for case in cross_ref_cases[:5]:
            cross_ref_context_text += f"\n--- Case: {case.get('title', 'Untitled')} ---\n"
            cross_ref_context_text += f"Summary: {case.get('summary', 'N/A')}\n"
            if case.get("entities"):
                cross_ref_context_text += f"Entities: {', '.join(case['entities'][:10])}\n"
            for et in case.get("evidence_texts", [])[:5]:
                cross_ref_context_text += f"Evidence: {et[:400]}\n"
        yield _sse("step_status", {
            "step": "case_crossref", "label": "Case Cross-Reference", "status": "done",
            "detail": f"{len(cross_ref_cases)} case(s) loaded",
        })
    else:
        cross_ref_context_text = ""
        yield _sse("step_status", {"step": "case_crossref", "label": "Case Cross-Reference", "status": "done", "detail": "Skipped"})

    await asyncio.sleep(0.3)

    # Emit entity suggestions before verdict synthesis
    yield _sse("entity_suggestions", {"entities": entity_suggestions})

    # -------------------------------------------------------------------
    # Phase T-G: Verdict Synthesis
    # -------------------------------------------------------------------
    yield _sse("step_status", {"step": "verdict_synthesis", "label": "Rendering Verdict", "status": "running"})
    await asyncio.sleep(0.1)

    # Build context sections
    supporting_ctx = ""
    for c in supporting_chunks[:25]:
        supporting_ctx += f"[Source: {c.get('filename', '?')}, Page: {c.get('page', '?')}]\n{_truncate_at_sentence(c['text'])}\n\n"
        all_sources.append({"filename": c.get("filename", "?"), "page": c.get("page", "?"), "score": round(c.get("score", 0) or 0, 3)})

    contradicting_ctx = ""
    for c in contradicting_chunks[:25]:
        contradicting_ctx += f"[Source: {c.get('filename', '?')}, Page: {c.get('page', '?')}]\n{_truncate_at_sentence(c['text'])}\n\n"
        all_sources.append({"filename": c.get("filename", "?"), "page": c.get("page", "?"), "score": round(c.get("score", 0) or 0, 3)})

    entity_ctx = ""
    for name, intel in entity_intels.items():
        entity_ctx += f"\n{intel.get('entity_name', name)} ({intel.get('entity_type', '?')})\n"
        entity_ctx += f"  Description: {intel.get('description', 'N/A')[:300]}\n"
        entity_ctx += f"  Connections: {intel.get('edge_count', 0)}\n"
        connected = [e.get("label", "") for e in intel.get("connected_entities", [])[:10]]
        if connected:
            entity_ctx += f"  Connected to: {', '.join(connected)}\n"

    graph_ctx = ""
    for e in graph_evidence[:30]:
        ev_text = e.get("evidence_text", "")
        if ev_text:
            graph_ctx += f"[Graph: {e.get('source', '?')} -> {e.get('predicate', 'related')} -> {e.get('target', '?')}]\n{ev_text[:300]}\n\n"

    claims_text = ""
    for i, claim in enumerate(claims):
        claims_text += f"{i+1}. {claim.get('claim_text', '')}\n"

    assumptions_text = "\n".join(f"- {a}" for a in implicit_assumptions) if implicit_assumptions else "None identified."

    gaps_text = ""
    if errors_log:
        gaps_text += "Pipeline errors:\n" + "\n".join(f"- {e}" for e in errors_log) + "\n"
    # Note claims with zero results
    for i, claim in enumerate(claims[:3]):
        # Check if this claim had any results at all
        claim_text_lower = claim.get("claim_text", "").lower()
        has_supporting = any(claim_text_lower[:20] in c.get("text", "").lower() for c in supporting_chunks[:5])
        if not has_supporting and not contradicting_chunks:
            gaps_text += f"- Claim {i+1} yielded limited direct search results\n"

    cross_ref_section = ""
    if cross_ref_context_text:
        cross_ref_section = f"CROSS-REFERENCED CASE EVIDENCE:\n{cross_ref_context_text}"

    synthesis_prompt = (
        "You are an impartial investigative analyst. You have been given a theory and evidence "
        "both FOR and AGAINST it. Your job is to render a fair, evidence-based verdict.\n\n"
        "CRITICAL RULES FOR IMPARTIALITY:\n"
        "1. You MUST give equal analytical weight to contradicting evidence as to supporting evidence.\n"
        "2. You MUST NOT dismiss contradicting evidence without specific, cited reasoning.\n"
        "3. If evidence is ambiguous, classify it as ambiguous — do not default to \"supporting.\"\n"
        "4. Absence of contradicting evidence is NOT the same as supporting evidence. State this explicitly.\n"
        "5. Every factual claim in your report MUST cite a specific source using [Source: filename, Page: X] or [Graph: entity1 -> predicate -> entity2].\n\n"
        f"THEORY UNDER INVESTIGATION:\n{theory}\n\n"
        f"CLAIMS BEING TESTED:\n{claims_text}\n"
        f"NULL HYPOTHESIS (what would be true if the theory is wrong):\n{null_hypothesis or 'Not generated.'}\n\n"
        f"IMPLICIT ASSUMPTIONS:\n{assumptions_text}\n\n"
        f"SUPPORTING EVIDENCE:\n{supporting_ctx or 'No supporting evidence found in corpus.'}\n\n"
        f"CONTRADICTING EVIDENCE:\n{contradicting_ctx or 'No contradicting evidence found in corpus.'}\n\n"
        f"{cross_ref_section}\n"
        f"ENTITY INTELLIGENCE:\n{entity_ctx or 'No entity profiles found.'}\n\n"
        f"GRAPH EVIDENCE:\n{graph_ctx or 'No graph evidence found.'}\n\n"
        f"DATA GAPS:\n{gaps_text or 'None.'}\n\n"
        "Write your report with EXACTLY these sections:\n\n"
        "## Verdict\n"
        "State one of: SUPPORTED / PARTIALLY SUPPORTED / INCONCLUSIVE / CONTRADICTED\n"
        "Followed by a confidence score (0.0 to 1.0) and a 2-3 sentence justification.\n\n"
        "## Theory Statement\nRestate the theory being tested.\n\n"
        "## Claim-by-Claim Analysis\n"
        "For each claim:\n"
        "### Claim N: [claim text]\n"
        "**Finding:** Supported / Partially Supported / Inconclusive / Contradicted\n"
        "**Strength:** Strong / Moderate / Weak\n"
        "**Supporting Evidence:**\n- [cited evidence]\n"
        "**Contradicting Evidence:**\n- [cited evidence]\n"
        "**Assessment:** [1-2 sentences]\n\n"
        "## Key Supporting Evidence\nSummarize the strongest evidence supporting the theory. Cite every source.\n\n"
        "## Key Contradicting Evidence\n"
        "Summarize the strongest evidence contradicting the theory. Cite every source.\n"
        'If no contradicting evidence was found, explicitly state: "No direct contradicting evidence was found in the available corpus. '
        'This does not confirm the theory — it may reflect gaps in the available data."\n\n'
        "## Entities Discovered\nList key entities and their relevance to the theory.\n\n"
        "## Information Gaps\nWhat could not be verified? What additional evidence would be needed?\n\n"
        "## Investigative Recommendations\n3-5 specific follow-up investigation angles.\n\n"
        "Be thorough, cite every claim, and maintain strict impartiality."
    )

    # Stream synthesis
    synthesis_text_parts = []
    synthesis_failed = False
    chunk_queue = _queue.Queue()

    def _produce_chunks():
        try:
            stream = generate_stream(genai_client, model="gemini-2.0-flash", contents=synthesis_prompt)
            for chunk in stream:
                if chunk.text:
                    chunk_queue.put(("text", chunk.text))
        except Exception as exc:
            chunk_queue.put(("error", exc))
        finally:
            chunk_queue.put(None)

    try:
        loop = asyncio.get_event_loop()
        producer = loop.run_in_executor(None, _produce_chunks)

        while True:
            item = await asyncio.to_thread(chunk_queue.get)
            if item is None:
                break
            if item[0] == "error":
                raise item[1]
            elif item[0] == "text":
                synthesis_text_parts.append(item[1])
                yield _sse("text", {"text": item[1]})
            await asyncio.sleep(0.01)

        await producer
    except Exception as e:
        synthesis_failed = True
        yield _sse("text", {"text": f"\n\n**Report generation error:** {type(e).__name__}: {e}"})

    if synthesis_failed:
        yield _sse("step_status", {"step": "verdict_synthesis", "label": "Rendering Verdict", "status": "error", "detail": "Generation failed"})
    else:
        yield _sse("step_status", {"step": "verdict_synthesis", "label": "Rendering Verdict", "status": "done"})

    # Deduplicate sources
    seen_source_keys = set()
    unique_sources = []
    for s in all_sources:
        key = f"{s['filename']}:{s['page']}"
        if key not in seen_source_keys:
            seen_source_keys.add(key)
            unique_sources.append(s)

    yield _sse("sources", {"sources": unique_sources[:30]})

    # -------------------------------------------------------------------
    # Extract structured verdict
    # -------------------------------------------------------------------
    full_report = "".join(synthesis_text_parts)
    try:
        verdict_prompt = (
            "Extract structured data from this theory investigation report.\n"
            "Return JSON with:\n"
            '- "verdict": one of "supported", "partially_supported", "inconclusive", "contradicted"\n'
            '- "confidence": number 0.0 to 1.0\n'
            '- "supporting_count": number of supporting evidence items cited\n'
            '- "contradicting_count": number of contradicting evidence items cited\n'
            '- "entities": array of entity name strings discovered\n'
            '- "claims": array of objects with "text", "finding", "strength"\n'
            '- "category": best fit from money_laundering, fraud, trafficking, tax_evasion, obstruction, other\n'
            '- "suggested_questions": array of 3-5 follow-up questions\n\n'
            f"REPORT:\n{full_report[:8000]}\n\n"
            "Return JSON only."
        )

        verdict_res = await asyncio.to_thread(
            generate, genai_client, model="gemini-2.0-flash",
            contents=verdict_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        verdict_data = json.loads(_extract_json(verdict_res.text))

        yield _sse("theory_verdict", {
            "verdict": verdict_data.get("verdict", "inconclusive"),
            "confidence": verdict_data.get("confidence", 0.5),
            "supporting_count": verdict_data.get("supporting_count", len(supporting_chunks)),
            "contradicting_count": verdict_data.get("contradicting_count", len(contradicting_chunks)),
            "entities": verdict_data.get("entities", list(entity_intels.keys())),
            "claims": verdict_data.get("claims", []),
            "category": verdict_data.get("category", "other"),
            "suggested_questions": verdict_data.get("suggested_questions", []),
            "entity_suggestions": entity_suggestions,
        })
    except Exception as e:
        print(f"DEBUG: Verdict extraction failed: {e}")
        # Emit fallback verdict
        yield _sse("theory_verdict", {
            "verdict": "inconclusive",
            "confidence": 0.5,
            "supporting_count": len(supporting_chunks),
            "contradicting_count": len(contradicting_chunks),
            "entities": list(entity_intels.keys()),
            "claims": [],
            "category": "other",
            "suggested_questions": [],
            "entity_suggestions": entity_suggestions,
        })

    yield _sse("done", {})

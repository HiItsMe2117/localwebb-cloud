"""
Multi-step agentic investigation pipeline.
Yields SSE events as it progresses through phases:
  A) Query Analysis
  B) Entity Intel
  C) Graph Traversal
  D) Multi-Pass Semantic Search
  E) Keyword Search
  F) Synthesis (streamed)
"""

import json
import time
from typing import AsyncGenerator

from google.genai import types


def _sse(event_type: str, data: dict) -> str:
    """Format a server-sent event."""
    return f"data: {json.dumps({'type': event_type, **data})}\n\n"


async def run_investigation(
    query: str,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
) -> AsyncGenerator[str, None]:
    """
    Async generator that runs a multi-step investigation and yields SSE events.

    Event types:
      step_status  — { step, label, status: 'running'|'done'|'skipped', detail? }
      text         — { text }  (streamed report chunks)
      sources      — { sources: [...] }
      follow_ups   — { follow_ups: [...] }
      done         — { }
    """
    all_context_chunks = []  # Accumulated evidence across all phases
    all_sources = []
    seen_texts = set()  # Dedup across passes
    entity_intel = {}
    graph_evidence = []
    discovered_entities = []
    discovered_relationships = []

    def _add_chunks(chunks: list):
        """Deduplicate and accumulate context chunks."""
        for c in chunks:
            sig = c["text"][:200]
            if sig not in seen_texts:
                seen_texts.add(sig)
                all_context_chunks.append(c)

    # ---------------------------------------------------------------
    # Phase A: Query Analysis (~1s)
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "query_analysis", "label": "Analyzing Query", "status": "running"})

    try:
        analysis_prompt = (
            "You are an investigative intelligence analyst. Analyze this query and extract structured information.\n\n"
            "RULES:\n"
            '- "primary_entity" MUST be a specific named person, organization, or location mentioned in the query. '
            "Generic words like 'network', 'individuals', 'transactions', 'documents' are NOT entities. "
            "If the query does not mention a specific named entity, set primary_entity to an empty string.\n"
            '- "secondary_entities": other specific named entities mentioned or implied (list of strings, empty if none)\n'
            '- "key_terms": important search terms and phrases for document retrieval (list of strings)\n'
            '- "reformulated_queries": 2-3 alternative phrasings to find relevant documents (list of strings)\n\n'
            "EXAMPLES:\n"
            'Query: "What can you tell me about Jeffrey Epstein?" → primary_entity: "Jeffrey Epstein"\n'
            'Query: "Who are the key individuals connected to this network?" → primary_entity: "" (no specific named entity)\n'
            'Query: "What is the connection between Israel and the Clinton Foundation?" → primary_entity: "Israel", secondary_entities: ["Clinton Foundation"]\n'
            'Query: "What financial transactions appear suspicious?" → primary_entity: "" (no specific named entity)\n\n'
            f"Query: {query}\n\n"
            "Return JSON only."
        )
        analysis_res = genai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=analysis_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        analysis = json.loads(analysis_res.text)
        primary_entity = analysis.get("primary_entity", "").strip()
        secondary_entities = analysis.get("secondary_entities", [])
        key_terms = analysis.get("key_terms", [])
        reformulated_queries = analysis.get("reformulated_queries", [])
    except Exception as e:
        print(f"DEBUG: Query analysis failed: {e}")
        primary_entity = ""
        secondary_entities = []
        key_terms = [query.strip()]
        reformulated_queries = []

    detail_parts = []
    if primary_entity:
        detail_parts.append(f"Primary: {primary_entity}")
    if secondary_entities:
        detail_parts.append(f"+{len(secondary_entities)} entities")
    if not detail_parts:
        detail_parts.append("General query — using semantic search")

    yield _sse("step_status", {
        "step": "query_analysis", "label": "Analyzing Query", "status": "done",
        "detail": ", ".join(detail_parts),
    })

    # ---------------------------------------------------------------
    # Phase B: Entity Intel (~0.5s)
    # ---------------------------------------------------------------
    has_entity = bool(primary_entity)

    if has_entity:
        yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "running"})

        try:
            from api.graph_ops import lookup_entity_intel
        except ImportError:
            from graph_ops import lookup_entity_intel

        try:
            entity_intel = lookup_entity_intel(supabase_client, primary_entity)
            if entity_intel.get("found"):
                discovered_entities = [
                    e.get("label", e.get("id", "")) for e in entity_intel.get("connected_entities", [])
                ]
                discovered_relationships = list(entity_intel.get("relationship_types", {}).keys())
                detail = f"{entity_intel['edge_count']} connections, {len(discovered_entities)} linked entities"
            else:
                detail = "Not found in knowledge graph"
        except Exception as e:
            print(f"DEBUG: Entity intel failed: {e}")
            detail = f"Error: {e}"

        yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "done", "detail": detail})
    else:
        yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "done", "detail": "Skipped — no named entity"})

    # ---------------------------------------------------------------
    # Phase C: Graph Traversal (~0.5s)
    # ---------------------------------------------------------------
    if entity_intel.get("found"):
        yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "running"})

        try:
            from api.graph_ops import bfs_collect_evidence
        except ImportError:
            from graph_ops import bfs_collect_evidence

        try:
            graph_evidence = bfs_collect_evidence(supabase_client, entity_intel["entity_id"], max_hops=2, max_edges=50)
            detail = f"Collected {len(graph_evidence)} edges across 2 hops"
        except Exception as e:
            print(f"DEBUG: Graph traversal failed: {e}")
            graph_evidence = []
            detail = f"Error: {e}"

        yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "done", "detail": detail})
    else:
        yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "done", "detail": "Skipped"})

    # ---------------------------------------------------------------
    # Phase D: Multi-Pass Semantic Search (~2-4s)
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running", "detail": "Pass 1..."})

    pass_count = 0

    # Pass 1: Original query
    try:
        pass1 = semantic_search_fn(
            query_text=query,
            genai_client=genai_client,
            pinecone_index=pinecone_index,
            rerank_fn=rerank_fn,
            fetch_k=50,
            rerank_top_n=5,
        )
        _add_chunks(pass1)
        pass_count += 1
    except Exception as e:
        print(f"DEBUG: Semantic search pass 1 failed: {e}")

    # Heartbeat between passes
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running", "detail": f"Pass 1 done ({len(all_context_chunks)} chunks). Pass 2..."})

    # Pass 2: Reformulated with discovered context
    reformulated = None
    if reformulated_queries:
        reformulated = reformulated_queries[0]
    elif discovered_entities:
        reformulated = f"{query} {' '.join(discovered_entities[:3])}"

    if reformulated:
        try:
            pass2 = semantic_search_fn(
                query_text=reformulated,
                genai_client=genai_client,
                pinecone_index=pinecone_index,
                rerank_fn=rerank_fn,
                fetch_k=50,
                rerank_top_n=5,
            )
            _add_chunks(pass2)
            pass_count += 1
        except Exception as e:
            print(f"DEBUG: Semantic search pass 2 failed: {e}")

    # Heartbeat
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running", "detail": f"{pass_count} passes ({len(all_context_chunks)} chunks)"})

    # Pass 3 (conditional): Focused on most important connected entity
    top_connected = None
    if discovered_entities:
        top_connected = discovered_entities[0]
    elif secondary_entities:
        top_connected = secondary_entities[0]

    if top_connected and primary_entity:
        try:
            pass3 = semantic_search_fn(
                query_text=f"{primary_entity} {top_connected}",
                genai_client=genai_client,
                pinecone_index=pinecone_index,
                rerank_fn=rerank_fn,
                fetch_k=40,
                rerank_top_n=5,
            )
            _add_chunks(pass3)
            pass_count += 1
        except Exception as e:
            print(f"DEBUG: Semantic search pass 3 failed: {e}")

    yield _sse("step_status", {
        "step": "semantic_search", "label": "Research", "status": "done",
        "detail": f"{pass_count} passes, {len(all_context_chunks)} unique chunks",
    })

    # ---------------------------------------------------------------
    # Phase E: Keyword Search (~1s)
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "keyword_search", "label": "Keyword Search", "status": "running"})

    keyword_results = []
    try:
        # Build search names from discovered entities
        search_names = []
        if primary_entity:
            search_names.append(primary_entity)
        search_names.extend(secondary_entities[:2])
        search_names.extend(discovered_entities[:2])
        search_names = [n for n in search_names if n and len(n) > 2]

        # Pinecone metadata filter search for key entity names
        for name in search_names[:3]:
            try:
                pc_filter = {"people": {"$in": [name]}}
                kw_results = semantic_search_fn(
                    query_text=name,
                    genai_client=genai_client,
                    pinecone_index=pinecone_index,
                    rerank_fn=None,
                    fetch_k=10,
                    rerank_top_n=5,
                    pinecone_filter=pc_filter,
                )
                _add_chunks(kw_results)
            except Exception:
                pass

        # Supabase evidence_text search
        try:
            from api.graph_ops import keyword_search_evidence
        except ImportError:
            from graph_ops import keyword_search_evidence

        if supabase_client and search_names:
            keyword_results = keyword_search_evidence(supabase_client, search_names[:5], limit=10)

    except Exception as e:
        print(f"DEBUG: Keyword search failed: {e}")

    yield _sse("step_status", {
        "step": "keyword_search", "label": "Keyword Search", "status": "done",
        "detail": f"{len(all_context_chunks)} total chunks, {len(keyword_results)} graph matches",
    })

    # ---------------------------------------------------------------
    # Phase F: Synthesis (streamed, ~5-8s)
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "running"})

    # Build context from all accumulated evidence
    context_parts = []

    # Document chunks from semantic search
    for c in all_context_chunks:
        context_parts.append(f"[Source: {c['filename']}, Page: {c['page']}]\n{c['text'][:1200]}")
        all_sources.append({"filename": c["filename"], "page": c["page"], "score": round(c.get("score", 0) or 0, 3)})

    # Graph edge evidence
    if graph_evidence:
        graph_ctx = "\n\nKNOWLEDGE GRAPH EVIDENCE:\n"
        for e in graph_evidence[:30]:
            ev_text = e.get("evidence_text", "")
            if ev_text:
                src_file = e.get("source_filename", "graph")
                graph_ctx += f"[Source: {src_file}, Relationship: {e.get('predicate', 'related')}]\n"
                graph_ctx += f"{e['source']} --[{e.get('predicate', 'related')}]--> {e['target']}: {ev_text}\n\n"
        context_parts.append(graph_ctx)

    # Entity intel summary
    if entity_intel.get("found"):
        intel_ctx = f"\n\nENTITY PROFILE: {entity_intel['entity_name']}\n"
        intel_ctx += f"Type: {entity_intel['entity_type']}\n"
        intel_ctx += f"Description: {entity_intel.get('description', 'N/A')}\n"
        intel_ctx += f"Aliases: {', '.join(entity_intel.get('aliases', []))}\n"
        intel_ctx += f"Total connections: {entity_intel['edge_count']}\n"
        intel_ctx += f"Connected entities: {', '.join(discovered_entities[:15])}\n"
        intel_ctx += f"Relationship types: {', '.join(discovered_relationships[:10])}\n"
        context_parts.append(intel_ctx)

    # Keyword evidence from graph
    if keyword_results:
        kw_ctx = "\n\nKEYWORD MATCHES IN EVIDENCE:\n"
        for e in keyword_results[:10]:
            kw_ctx += f"- {e.get('source', '?')} --[{e.get('predicate', '?')}]--> {e.get('target', '?')}: {e.get('evidence_text', '')[:300]}\n"
        context_parts.append(kw_ctx)

    full_context = "\n\n---\n\n".join(context_parts)

    if not full_context.strip():
        yield _sse("text", {"text": "No relevant information was found in the database for this query. Try uploading documents first, or rephrase your query with more specific terms."})
        yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "done", "detail": "No context available"})
        yield _sse("done", {})
        return

    synthesis_prompt = (
        "You are an elite investigative intelligence analyst writing a comprehensive investigative report.\n\n"
        "CONTEXT (documents, graph intelligence, entity profiles):\n"
        f"{full_context}\n\n"
        f"INVESTIGATION QUERY: {query}\n\n"
        "Write a thorough investigative report with these sections:\n"
        "## Executive Summary\nBrief overview of key findings.\n\n"
        "## Key Connections\nImportant relationships and links discovered.\n\n"
        "## Document Evidence\nSpecific evidence from source documents with citations [Source: filename].\n\n"
        "## Timeline\nChronological events if dates are available.\n\n"
        "## Assessment\nAnalytical assessment of the findings.\n\n"
        "Cite sources using [Source: filename] tags. Be thorough but precise. "
        "Do not fabricate information not supported by the provided context."
    )

    try:
        stream = genai_client.models.generate_content_stream(
            model="gemini-2.5-pro",
            contents=synthesis_prompt,
        )
        for chunk in stream:
            if chunk.text:
                yield _sse("text", {"text": chunk.text})
    except Exception as e:
        yield _sse("text", {"text": f"\n\n*Report generation error: {e}*"})

    yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "done"})

    # Deduplicate sources
    seen_source_files = set()
    unique_sources = []
    for s in all_sources:
        key = f"{s['filename']}:{s['page']}"
        if key not in seen_source_files:
            seen_source_files.add(key)
            unique_sources.append(s)

    yield _sse("sources", {"sources": unique_sources[:20]})

    # Generate follow-up questions
    try:
        followup_prompt = (
            f"Based on this investigation about '{query}', suggest 3-4 specific follow-up questions "
            f"that would deepen the investigation. Focus on unexplored connections, missing evidence, "
            f"or related entities. Return JSON array of strings.\n\n"
            f"Key entities found: {primary_entity}, {', '.join(discovered_entities[:5])}\n"
            f"Relationships: {', '.join(discovered_relationships[:5])}"
        )
        followup_res = genai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=followup_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        follow_ups = json.loads(followup_res.text)
        if isinstance(follow_ups, list):
            yield _sse("follow_ups", {"follow_ups": follow_ups[:4]})
    except Exception as e:
        print(f"DEBUG: Follow-up generation failed: {e}")

    yield _sse("done", {})

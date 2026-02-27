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
import queue as _queue
import traceback
import asyncio
import re
import urllib.parse
from typing import AsyncGenerator

from google.genai import types


def _sse(event_type: str, data: dict) -> str:
    """Format a server-sent event."""
    return f"data: {json.dumps({'type': event_type, **data})}\n\n"


def _extract_json(text: str) -> str:
    """Robustly extract JSON from model output."""
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        return match.group(0)
    return text


def _truncate_at_sentence(text: str, max_len: int = 1200) -> str:
    """Truncate text at the last sentence boundary before max_len."""
    if len(text) <= max_len:
        return text
    truncated = text[:max_len]
    # Find the last sentence-ending punctuation
    last_period = truncated.rfind('.')
    last_newline = truncated.rfind('\n')
    boundary = max(last_period, last_newline)
    if boundary > max_len // 2:
        return truncated[:boundary + 1]
    return truncated


def _safe_semantic_pass(semantic_search_fn, query_text, genai_client, pinecone_index,
                        rerank_fn=None, fetch_k=50, rerank_top_n=5, pinecone_filter=None):
    """Wrapper around semantic_search_fn with detailed error capture."""
    try:
        # Note: semantic_search_fn is synchronous in this codebase
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


async def run_investigation(
    query: str,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
    case_context: dict = None,
    mode: str = "files_only",
) -> AsyncGenerator[str, None]:
    """
    Async generator that runs a multi-step investigation and yields SSE events.
    Optional case_context dict enriches the query with case-specific info:
      { title, summary, entities, suggested_questions }
    mode: "files_only" (strict document-only) or "files_web" (supplement with Google Search)
    """
    # If case context provided, enrich the query
    if case_context:
        enriched_parts = [query]
        if case_context.get("summary"):
            enriched_parts.append(f"Case background: {case_context['summary']}")
        if case_context.get("entities"):
            enriched_parts.append(f"Key entities: {', '.join(case_context['entities'][:10])}")
        if case_context.get("suggested_questions"):
            enriched_parts.append(f"Investigation angles: {'; '.join(case_context['suggested_questions'][:4])}")
        query = "\n".join(enriched_parts)

    try:
        async for event in _run_investigation_inner(
            query, genai_client, pinecone_index, supabase_client,
            semantic_search_fn, rerank_fn, mode=mode,
        ):
            yield event
    except Exception as e:
        tb = traceback.format_exc()
        print(f"CRITICAL: Investigation pipeline crashed: {tb}")
        yield _sse("text", {"text": f"\n\n**Pipeline error:** {type(e).__name__}: {e}"})
        yield _sse("done", {})


async def _run_investigation_inner(
    query: str,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
    mode: str = "files_only",
) -> AsyncGenerator[str, None]:
    all_context_chunks = []
    all_sources = []
    seen_texts = set()
    entity_intel = {}
    graph_evidence = []
    discovered_entities = []
    discovered_relationships = []
    errors_log = []

    def _add_chunks(chunks: list):
        if not isinstance(chunks, list):
            return
        for c in chunks:
            if not isinstance(c, dict) or "text" not in c:
                continue
            sig = re.sub(r'\s+', ' ', c["text"][:500]).strip()
            if sig not in seen_texts:
                seen_texts.add(sig)
                all_context_chunks.append(c)

    # ---------------------------------------------------------------
    # Phase A: Query Analysis
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "query_analysis", "label": "Analyzing Query", "status": "running"})
    await asyncio.sleep(0.1) # Flush

    analysis_failed = False
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
            f"Query: {query}\n\n"
            "Return JSON only."
        )

        # Use asyncio.to_thread for blocking GenAI call
        analysis_res = await asyncio.to_thread(
            genai_client.models.generate_content,
            model="gemini-2.0-flash",
            contents=analysis_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )

        analysis_text = _extract_json(analysis_res.text)
        analysis = json.loads(analysis_text)

        primary_entity = analysis.get("primary_entity", "").strip()
        secondary_entities = analysis.get("secondary_entities", [])
        key_terms = analysis.get("key_terms", [])
        reformulated_queries = analysis.get("reformulated_queries", [])
    except Exception as e:
        print(f"DEBUG: Query analysis failed: {e}")
        errors_log.append(f"Query Analysis: {type(e).__name__} — fell back to raw query")
        analysis_failed = True
        primary_entity = ""
        secondary_entities = []
        key_terms = [query.strip()]
        reformulated_queries = []

    if analysis_failed:
        yield _sse("step_status", {
            "step": "query_analysis", "label": "Analyzing Query", "status": "error",
            "detail": f"Falling back to raw query",
        })
    else:
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
    await asyncio.sleep(0.3) # Pacing

    # ---------------------------------------------------------------
    # Phase B: Entity Intel
    # ---------------------------------------------------------------
    has_entity = bool(primary_entity)

    if has_entity:
        yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "running"})
        await asyncio.sleep(0.1)

        try:
            from api.graph_ops import lookup_entity_intel
        except ImportError:
            from graph_ops import lookup_entity_intel

        try:
            # Supabase call is blocking, use thread
            entity_intel = await asyncio.to_thread(lookup_entity_intel, supabase_client, primary_entity)
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
            errors_log.append(f"Entity Intel: {type(e).__name__} — entity profile unavailable")
            yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "error", "detail": f"{type(e).__name__}: {e}"})
            detail = None

        if detail is not None:
            yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "done", "detail": detail})
    else:
        yield _sse("step_status", {"step": "entity_intel", "label": "Entity Intelligence", "status": "done", "detail": "Skipped — no named entity"})
    
    await asyncio.sleep(0.3)

    # ---------------------------------------------------------------
    # Phase C: Graph Traversal
    # ---------------------------------------------------------------
    if entity_intel.get("found"):
        yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "running"})
        await asyncio.sleep(0.1)

        try:
            from api.graph_ops import bfs_collect_evidence
        except ImportError:
            from graph_ops import bfs_collect_evidence

        try:
            # Blocking Supabase/BFS call
            graph_evidence = await asyncio.to_thread(
                bfs_collect_evidence, supabase_client, entity_intel["entity_id"], max_hops=2, max_edges=50
            )
            detail = f"Collected {len(graph_evidence)} edges across 2 hops"
        except Exception as e:
            print(f"DEBUG: Graph traversal failed: {e}")
            errors_log.append(f"Graph Traversal: {type(e).__name__} — graph evidence unavailable")
            graph_evidence = []
            yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "error", "detail": f"{type(e).__name__}: {e}"})
            detail = None

        if detail is not None:
            yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "done", "detail": detail})
    else:
        yield _sse("step_status", {"step": "graph_traversal", "label": "Graph Traversal", "status": "done", "detail": "Skipped"})

    await asyncio.sleep(0.3)

    # ---------------------------------------------------------------
    # Phase D: Multi-Pass Semantic Search
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running", "detail": "Starting pass 1..."})
    await asyncio.sleep(0.1)

    pass_count = 0
    errors = []

    # Pass 1: Original query
    results, err = await asyncio.to_thread(
        _safe_semantic_pass,
        semantic_search_fn, query, genai_client, pinecone_index,
        rerank_fn=rerank_fn, fetch_k=50, rerank_top_n=5,
    )
    if err:
        errors.append(f"Pass 1: {err}")
    else:
        _add_chunks(results)
        pass_count += 1

    # Heartbeat
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running",
                "detail": f"Pass 1 {'OK' if not err else 'failed'} ({len(all_context_chunks)} chunks). Pass 2..."})
    await asyncio.sleep(0.2)

    # Pass 2: Reformulated with discovered context
    reformulated = None
    if len(reformulated_queries) >= 2:
        reformulated = f"{reformulated_queries[0]} {reformulated_queries[1]}"
    elif reformulated_queries:
        reformulated = reformulated_queries[0]
    elif discovered_entities:
        reformulated = f"{query} {' '.join(discovered_entities[:3])}"

    if reformulated:
        results, err = await asyncio.to_thread(
            _safe_semantic_pass,
            semantic_search_fn, reformulated, genai_client, pinecone_index,
            rerank_fn=rerank_fn, fetch_k=50, rerank_top_n=5,
        )
        if err:
            errors.append(f"Pass 2: {err}")
        else:
            _add_chunks(results)
            pass_count += 1

    # Heartbeat
    yield _sse("step_status", {"step": "semantic_search", "label": "Research", "status": "running",
                "detail": f"{pass_count} passes ({len(all_context_chunks)} chunks)"})
    await asyncio.sleep(0.2)

    # Pass 3 (conditional): Focused on most important connected entity, or unused reformulation
    top_connected = None
    if discovered_entities:
        top_connected = discovered_entities[0]
    elif secondary_entities:
        top_connected = secondary_entities[0]

    pass3_query = None
    if top_connected and primary_entity:
        pass3_query = f"{primary_entity} {top_connected}"
    elif len(reformulated_queries) >= 3:
        pass3_query = reformulated_queries[2]
    elif len(reformulated_queries) >= 2 and not top_connected:
        pass3_query = reformulated_queries[1]

    if pass3_query:
        results, err = await asyncio.to_thread(
            _safe_semantic_pass,
            semantic_search_fn, pass3_query, genai_client, pinecone_index,
            rerank_fn=rerank_fn, fetch_k=40, rerank_top_n=5,
        )
        if err:
            errors.append(f"Pass 3: {err}")
        else:
            _add_chunks(results)
            pass_count += 1

    if errors:
        errors_log.append(f"Semantic Search: {len(errors)} pass(es) failed — {'; '.join(errors)}")

    if errors and not all_context_chunks:
        yield _sse("step_status", {
            "step": "semantic_search", "label": "Research", "status": "error",
            "detail": f"All passes failed: {'; '.join(errors)}",
        })
    else:
        done_detail = f"{pass_count} passes, {len(all_context_chunks)} unique chunks"
        if errors:
            done_detail += f" ({len(errors)} errors)"
        yield _sse("step_status", {
            "step": "semantic_search", "label": "Research", "status": "done",
            "detail": done_detail,
        })
    await asyncio.sleep(0.3)

    # ---------------------------------------------------------------
    # Phase E: Keyword Search
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "keyword_search", "label": "Keyword Search", "status": "running"})
    await asyncio.sleep(0.1)

    keyword_results = []
    keyword_failed = False
    try:
        search_names = []
        if primary_entity:
            search_names.append(primary_entity)
        search_names.extend(secondary_entities[:2])
        search_names.extend(discovered_entities[:2])
        search_names = [n for n in search_names if n and len(n) > 2]

        for name in search_names[:3]:
            try:
                pc_filter = {"people": {"$in": [name]}}
                kw_results, _ = await asyncio.to_thread(
                    _safe_semantic_pass,
                    semantic_search_fn, name, genai_client, pinecone_index,
                    rerank_fn=None, fetch_k=10, rerank_top_n=5, pinecone_filter=pc_filter,
                )
                _add_chunks(kw_results)
            except Exception:
                pass

        try:
            from api.graph_ops import keyword_search_evidence
        except ImportError:
            from graph_ops import keyword_search_evidence

        if supabase_client and search_names:
            keyword_results = await asyncio.to_thread(
                keyword_search_evidence, supabase_client, search_names[:5], limit=10
            )

    except Exception as e:
        print(f"DEBUG: Keyword search failed: {e}")
        errors_log.append(f"Keyword Search: {type(e).__name__} — keyword matches unavailable")
        keyword_failed = True
        keyword_error = f"{type(e).__name__}: {e}"

    if keyword_failed:
        yield _sse("step_status", {
            "step": "keyword_search", "label": "Keyword Search", "status": "error",
            "detail": keyword_error,
        })
    else:
        yield _sse("step_status", {
            "step": "keyword_search", "label": "Keyword Search", "status": "done",
            "detail": f"{len(all_context_chunks)} total chunks, {len(keyword_results)} graph matches",
        })
    await asyncio.sleep(0.3)

    # ---------------------------------------------------------------
    # Phase F: Synthesis
    # ---------------------------------------------------------------
    yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "running"})
    await asyncio.sleep(0.1)

    context_parts = []

    for c in all_context_chunks:
        context_parts.append(f"[Source: {c['filename']}, Page: {c['page']}]\n{_truncate_at_sentence(c['text'])}")
        all_sources.append({"filename": c["filename"], "page": c["page"], "score": round(c.get("score", 0) or 0, 3)})

    if graph_evidence:
        graph_ctx = "\n\nKNOWLEDGE GRAPH EVIDENCE:\n"
        for e in graph_evidence[:30]:
            ev_text = e.get("evidence_text", "")
            if ev_text:
                src_file = e.get("source_filename", "graph")
                graph_ctx += f"[Source: {src_file}, Relationship: {e.get('predicate', 'related')}]\n"
                graph_ctx += f"{e['source']} --[{e.get('predicate', 'related')}]--> {e['target']}: {ev_text}\n\n"
        context_parts.append(graph_ctx)

    if entity_intel.get("found"):
        intel_ctx = f"\n\nENTITY PROFILE: {entity_intel['entity_name']}\n"
        intel_ctx += f"Type: {entity_intel['entity_type']}\n"
        intel_ctx += f"Description: {entity_intel.get('description', 'N/A')}\n"
        intel_ctx += f"Aliases: {', '.join(entity_intel.get('aliases', []))}\n"
        intel_ctx += f"Total connections: {entity_intel['edge_count']}\n"
        intel_ctx += f"Connected entities: {', '.join(discovered_entities[:15])}\n"
        intel_ctx += f"Relationship types: {', '.join(discovered_relationships[:10])}\n"
        context_parts.append(intel_ctx)

    if keyword_results:
        kw_ctx = "\n\nKEYWORD MATCHES IN EVIDENCE:\n"
        for e in keyword_results[:10]:
            kw_ctx += f"- {e.get('source', '?')} --[{e.get('predicate', '?')}]--> {e.get('target', '?')}: {e.get('evidence_text', '')[:300]}\n"
        context_parts.append(kw_ctx)

    full_context = "\n\n---\n\n".join(context_parts)

    if errors_log:
        gaps = "\n\nDATA GAPS (some pipeline phases failed — caveat findings accordingly):\n"
        for err_msg in errors_log:
            gaps += f"- {err_msg}\n"
        full_context += gaps

    if not full_context.strip():
        yield _sse("text", {"text": "No relevant information was found in the database for this query. Try uploading documents first, or rephrase your query with more specific terms."})
        yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "done", "detail": "No context available"})
        yield _sse("done", {})
        return

    # Build mode-specific synthesis prompt
    report_sections = (
        "Write a thorough investigative report with these sections:\n"
        "## Executive Summary\nBrief overview of key findings.\n\n"
        "## Key Connections\nImportant relationships and links discovered.\n\n"
        "## Document Evidence\nSpecific evidence from source documents with citations [Source: filename].\n\n"
        "## Timeline\nChronological events if dates are available.\n\n"
        "## Assessment\nAnalytical assessment of the findings.\n\n"
        "Cite sources using [Source: filename] tags. Be thorough but precise."
    )

    if mode == "files_web":
        synthesis_prompt = (
            "You are an elite investigative intelligence analyst writing a comprehensive investigative report.\n\n"
            "CONTEXT (documents, graph intelligence, entity profiles):\n"
            f"{full_context}\n\n"
            f"INVESTIGATION QUERY: {query}\n\n"
            f"{report_sections}\n\n"
            "Prioritize evidence from the provided document context above. "
            "If the documents are insufficient to fully answer the query, supplement with Google Search. "
            "Prefix any web-sourced information with [Web]. "
            "Always clearly distinguish document evidence from web-sourced information."
        )
    else:
        synthesis_prompt = (
            "You are an elite investigative intelligence analyst writing a comprehensive investigative report.\n\n"
            "CONTEXT (documents, graph intelligence, entity profiles):\n"
            f"{full_context}\n\n"
            f"INVESTIGATION QUERY: {query}\n\n"
            f"{report_sections}\n\n"
            "ONLY use information from the provided context. "
            "Do not fabricate information not supported by the provided context. "
            "If the provided context is insufficient to fully answer the query, explicitly state what information is missing rather than speculating."
        )

    # Web search step (files_web mode only)
    if mode == "files_web":
        yield _sse("step_status", {"step": "web_search", "label": "Web Search", "status": "running", "detail": "Gemini will search if needed"})
        await asyncio.sleep(0.1)

    synthesis_failed = False
    synthesis_text_parts = []
    web_sources = []
    try:
        # Run the entire streaming call + iteration in a single background thread,
        # collecting chunks into a thread-safe queue so we can yield SSE events
        # from the async generator without blocking the event loop.
        chunk_queue = _queue.Queue()

        # Build config with optional Google Search tool
        synthesis_config = None
        if mode == "files_web":
            synthesis_config = types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )

        def _produce_chunks():
            try:
                kwargs = dict(
                    model="gemini-2.0-flash",
                    contents=synthesis_prompt,
                )
                if synthesis_config:
                    kwargs["config"] = synthesis_config
                stream = genai_client.models.generate_content_stream(**kwargs)
                for chunk in stream:
                    if chunk.text:
                        chunk_queue.put(("text", chunk.text))
                    # Collect grounding metadata from the final chunk
                    if hasattr(chunk, 'candidates') and chunk.candidates:
                        candidate = chunk.candidates[0]
                        gm = getattr(candidate, 'grounding_metadata', None)
                        if gm:
                            grounding_chunks = getattr(gm, 'grounding_chunks', None)
                            if grounding_chunks:
                                chunk_queue.put(("grounding", grounding_chunks))
            except Exception as exc:
                chunk_queue.put(("error", exc))
            finally:
                chunk_queue.put(None)  # sentinel

        # Start producer in a background thread
        loop = asyncio.get_event_loop()
        producer = loop.run_in_executor(None, _produce_chunks)

        # Consume chunks as they arrive
        while True:
            item = await asyncio.to_thread(chunk_queue.get)
            if item is None:
                break
            if item[0] == "error":
                raise item[1]
            elif item[0] == "grounding":
                # Extract web sources from grounding chunks
                for gc in item[1]:
                    web = getattr(gc, 'web', None)
                    if web:
                        uri = getattr(web, 'uri', '') or ''
                        title = getattr(web, 'title', '') or ''
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({"title": title, "uri": uri, "domain": domain})
            elif item[0] == "text":
                synthesis_text_parts.append(item[1])
                yield _sse("text", {"text": item[1]})
            await asyncio.sleep(0.01)

        await producer  # ensure thread completed
    except Exception as e:
        synthesis_failed = True
        yield _sse("text", {"text": f"\n\n**Report generation error:** {type(e).__name__}: {e}"})

    if synthesis_failed:
        yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "error", "detail": "Generation failed"})
    else:
        yield _sse("step_status", {"step": "synthesis", "label": "Writing Report", "status": "done"})

    # Emit web search step status and web sources
    if mode == "files_web":
        # Deduplicate web sources by URI
        seen_uris = set()
        unique_web_sources = []
        for ws in web_sources:
            if ws["uri"] not in seen_uris:
                seen_uris.add(ws["uri"])
                unique_web_sources.append(ws)
        if unique_web_sources:
            yield _sse("step_status", {"step": "web_search", "label": "Web Search", "status": "done", "detail": f"{len(unique_web_sources)} web sources"})
            yield _sse("web_sources", {"web_sources": unique_web_sources})
        else:
            yield _sse("step_status", {"step": "web_search", "label": "Web Search", "status": "done", "detail": "No web sources needed"})

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
        synthesis_summary = "".join(synthesis_text_parts)[:500] if synthesis_text_parts else ""
        followup_prompt = (
            f"Based on this investigation about '{query}', suggest 3-4 specific follow-up questions "
            f"that would deepen the investigation. Focus on unexplored connections, missing evidence, "
            f"or related entities. Return JSON array of strings.\n\n"
            f"Key entities found: {primary_entity}, {', '.join(discovered_entities[:5])}\n"
            f"Relationships: {', '.join(discovered_relationships[:5])}"
        )
        if synthesis_summary:
            followup_prompt += f"\n\nKey findings so far:\n{synthesis_summary}"
        followup_res = await asyncio.to_thread(
            genai_client.models.generate_content,
            model="gemini-2.0-flash",
            contents=followup_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        followup_text = _extract_json(followup_res.text)
        follow_ups = json.loads(followup_text)
        if isinstance(follow_ups, list):
            yield _sse("follow_ups", {"follow_ups": follow_ups[:4]})
    except Exception as e:
        print(f"DEBUG: Follow-up generation failed: {e}")

    yield _sse("done", {})


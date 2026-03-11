"""
Theory Follow-up Conversation Pipeline.
Lighter than the full 7-phase pipeline — receives accumulated context + conversation
history, optionally triggers a targeted semantic search, streams back a response.
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


async def run_theory_followup(
    theory: str,
    verdict_summary: str,
    entity_context: str,
    evidence_summary: str,
    messages: list,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
) -> AsyncGenerator[str, None]:
    try:
        async for event in _run_followup_inner(
            theory, verdict_summary, entity_context, evidence_summary,
            messages, genai_client, pinecone_index, supabase_client,
            semantic_search_fn, rerank_fn,
        ):
            yield event
    except Exception as e:
        tb = traceback.format_exc()
        print(f"CRITICAL: Theory follow-up crashed: {tb}")
        yield _sse("text", {"text": f"\n\n**Follow-up error:** {type(e).__name__}: {e}"})
        yield _sse("done", {})


async def _run_followup_inner(
    theory: str,
    verdict_summary: str,
    entity_context: str,
    evidence_summary: str,
    messages: list,
    genai_client,
    pinecone_index,
    supabase_client,
    semantic_search_fn,
    rerank_fn=None,
) -> AsyncGenerator[str, None]:
    user_question = messages[-1]["content"] if messages else ""

    # Step 1: Classify follow-up — does it need new evidence search?
    yield _sse("step_status", {"step": "classify", "label": "Analyzing Question", "status": "running"})

    classify_prompt = (
        "You are classifying an investigative follow-up question.\n"
        "Given the original theory, verdict, and conversation so far, determine if "
        "the user's latest question requires searching for NEW evidence in the document corpus, "
        "or if it can be answered from the existing context.\n\n"
        f"THEORY: {theory}\n"
        f"VERDICT: {verdict_summary}\n"
        f"USER QUESTION: {user_question}\n\n"
        'Return JSON: {"needs_search": true/false, "search_query": "..." (if needs_search), '
        '"entity_names": ["..."] (any new entities mentioned)}\n'
        "Return JSON only."
    )

    needs_search = False
    search_query = ""
    new_entity_names = []

    try:
        classify_res = await asyncio.to_thread(
            generate, genai_client, model="gemini-2.0-flash",
            contents=classify_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        classify_data = json.loads(_extract_json(classify_res.text))
        needs_search = classify_data.get("needs_search", False)
        search_query = classify_data.get("search_query", user_question)
        new_entity_names = classify_data.get("entity_names", [])[:5]
    except Exception as e:
        print(f"DEBUG: Follow-up classification failed: {e}")
        # Default to searching
        needs_search = True
        search_query = user_question

    yield _sse("step_status", {
        "step": "classify", "label": "Analyzing Question", "status": "done",
        "detail": "New search needed" if needs_search else "Using existing context",
    })

    # Step 2: Optional targeted search
    new_evidence = ""
    new_sources = []

    if needs_search and search_query:
        yield _sse("step_status", {"step": "search", "label": "Searching Evidence", "status": "running"})

        try:
            results, err = await asyncio.to_thread(
                _safe_semantic_pass, semantic_search_fn, search_query,
                genai_client, pinecone_index, rerank_fn=rerank_fn,
                fetch_k=50, rerank_top_n=5,
            )
            if not err and results:
                for r in results[:5]:
                    if isinstance(r, dict) and r.get("text"):
                        new_evidence += f"[Source: {r.get('filename', '?')}, Page: {r.get('page', '?')}]\n{r['text'][:800]}\n\n"
                        new_sources.append({
                            "filename": r.get("filename", "?"),
                            "page": r.get("page", "?"),
                            "score": round(r.get("score", 0) or 0, 3),
                        })
        except Exception as e:
            print(f"DEBUG: Follow-up search failed: {e}")

        # Entity intel for any new names
        new_entity_intels = ""
        if new_entity_names and supabase_client:
            try:
                from api.graph_ops import lookup_entity_intel
            except ImportError:
                from graph_ops import lookup_entity_intel

            for name in new_entity_names[:3]:
                try:
                    intel = await asyncio.to_thread(lookup_entity_intel, supabase_client, name)
                    if intel.get("found"):
                        new_entity_intels += (
                            f"\n{intel.get('entity_name', name)} ({intel.get('entity_type', '?')}): "
                            f"{intel.get('description', 'N/A')[:200]}, "
                            f"{intel.get('edge_count', 0)} connections\n"
                        )
                except Exception:
                    pass

        if new_entity_intels:
            new_evidence += f"\nNEW ENTITY INTEL:\n{new_entity_intels}"

        yield _sse("step_status", {
            "step": "search", "label": "Searching Evidence", "status": "done",
            "detail": f"{len(new_sources)} new sources",
        })

    # Step 3: Generate streamed response
    yield _sse("step_status", {"step": "response", "label": "Generating Response", "status": "running"})

    conversation_history = ""
    for msg in messages[:-1]:
        role = "User" if msg["role"] == "user" else "Analyst"
        conversation_history += f"{role}: {msg['content']}\n\n"

    response_prompt = (
        "You are continuing an investigative analysis. Your original verdict on the theory was: "
        f"{verdict_summary}\n\n"
        "CRITICAL RULES:\n"
        "1. If the evidence doesn't support the user's direction, say so directly.\n"
        "2. Do NOT confabulate connections — only cite evidence that exists.\n"
        "3. Every factual claim must reference a source using [Source: filename, Page: X].\n"
        "4. If you don't have evidence for something, say so explicitly.\n"
        "5. Maintain the same adversarial, impartial stance as the original analysis.\n\n"
        f"ORIGINAL THEORY: {theory}\n\n"
        f"ENTITY CONTEXT:\n{entity_context[:2000]}\n\n"
        f"EVIDENCE SUMMARY:\n{evidence_summary[:2000]}\n\n"
    )

    if new_evidence:
        response_prompt += f"NEWLY RETRIEVED EVIDENCE:\n{new_evidence[:3000]}\n\n"

    if conversation_history:
        response_prompt += f"CONVERSATION SO FAR:\n{conversation_history}\n\n"

    response_prompt += f"USER'S LATEST QUESTION: {user_question}\n\nProvide a thorough, evidence-based response."

    # Stream the response
    response_parts = []
    chunk_queue = _queue.Queue()

    def _produce_chunks():
        try:
            stream = generate_stream(genai_client, model="gemini-2.0-flash", contents=response_prompt)
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
                response_parts.append(item[1])
                yield _sse("text", {"text": item[1]})
            await asyncio.sleep(0.01)

        await producer
    except Exception as e:
        yield _sse("text", {"text": f"\n\n**Response generation error:** {type(e).__name__}: {e}"})

    yield _sse("step_status", {"step": "response", "label": "Generating Response", "status": "done"})

    if new_sources:
        yield _sse("sources", {"sources": new_sources})

    # Step 4: Check for new entity suggestions from the response
    full_response = "".join(response_parts)
    if new_entity_names and supabase_client:
        try:
            from api.graph_ops import lookup_entity_intel
        except ImportError:
            from graph_ops import lookup_entity_intel

        new_suggestions = []
        for name in new_entity_names:
            try:
                intel = await asyncio.to_thread(lookup_entity_intel, supabase_client, name)
                if intel.get("found"):
                    new_suggestions.append({
                        "name": intel.get("entity_name", name),
                        "id": intel.get("entity_id"),
                        "type": intel.get("entity_type", "UNKNOWN"),
                        "on_graph": True,
                        "edge_count": intel.get("edge_count", 0),
                    })
                else:
                    new_suggestions.append({
                        "name": name,
                        "id": None,
                        "type": "UNKNOWN",
                        "on_graph": False,
                        "edge_count": 0,
                    })
            except Exception:
                pass

        if new_suggestions:
            yield _sse("entity_suggestions", {"entities": new_suggestions})

    yield _sse("done", {})


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

"""
Suspicious activity scanner.
Analyzes the knowledge graph and document corpus for patterns
indicative of money laundering, fraud, trafficking, tax evasion, etc.
Returns structured findings for case proposals.
"""

import json
from google.genai import types


SCAN_PROMPT = """You are a forensic intelligence analyst. Analyze the following evidence from a knowledge graph and document corpus for suspicious patterns and activities.

ENTITY RELATIONSHIP MAP:
{entity_map}

DOCUMENT EXCERPTS (high-relevance chunks):
{doc_context}

ANALYSIS INSTRUCTIONS:
Look for these categories of suspicious activity:
- **money_laundering**: Shell companies, layered financial structures, unusual fund flows, structuring
- **fraud**: Misrepresentation, false documentation, identity fraud, investment schemes
- **trafficking**: Unusual travel patterns coinciding with financial movements, exploitation indicators
- **tax_evasion**: Unreported income, offshore structures, discrepancies between lifestyle and filings
- **obstruction**: Missing documentation, evidence gaps suggesting concealment, witness intimidation
- **other**: Any other suspicious patterns not fitting the above categories

For each finding, assess:
1. What specific entities are involved?
2. What is the evidence trail?
3. How confident are you (0.0 to 1.0)?
4. What investigation questions would help confirm or deny this?

Return a JSON object with a single key "findings" containing an array of objects, each with:
- "title": concise descriptive title (string)
- "category": one of money_laundering, fraud, trafficking, tax_evasion, obstruction, other (string)
- "summary": 2-4 sentence explanation of the suspicious pattern (string)
- "confidence": 0.0 to 1.0 (number)
- "entity_ids": list of entity IDs involved (array of strings)
- "suggested_questions": 2-4 investigation angles to pursue (array of strings)
- "sources": list of source objects citing specific evidence, each with "filename" (string) and "page" (string/number)

Return up to 10 findings, ordered by confidence (highest first). Only include findings with genuine evidentiary basis — do not fabricate patterns. Check your work: ensure all cited sources actually appear in the provided context."""


def run_scan(genai_client, supabase_client, pinecone_index, semantic_search_fn):
    """
    Scan the knowledge graph and documents for suspicious activity.
    Returns a list of structured findings.
    """
    # 1. Pull top entities by edge count from Supabase
    entity_map_text = _build_entity_map(supabase_client)

    # 2. Pull high-relevance document chunks from Pinecone
    doc_context = _sample_documents(genai_client, pinecone_index, semantic_search_fn)

    if not entity_map_text and not doc_context:
        return []

    # 3. Send to Gemini for analysis
    prompt = SCAN_PROMPT.format(
        entity_map=entity_map_text or "(No graph data available)",
        doc_context=doc_context or "(No document excerpts available)",
    )

    res = genai_client.models.generate_content(
        model="gemini-2.5-pro",
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )

    # 4. Parse and return findings
    try:
        data = json.loads(res.text)
        findings = data.get("findings", [])
        if isinstance(findings, list):
            return findings[:10]
    except (json.JSONDecodeError, TypeError):
        pass

    return []


def _build_entity_map(supabase_client):
    """Pull top entities by degree and their relationships."""
    try:
        # Get all edges to compute degree
        edges_res = supabase_client.table("edges").select("source,target,predicate,evidence_text,source_filename").execute()
        edges = edges_res.data or []

        if not edges:
            return ""

        # Compute degree for each entity
        degree = {}
        for e in edges:
            degree[e["source"]] = degree.get(e["source"], 0) + 1
            degree[e["target"]] = degree.get(e["target"], 0) + 1

        # Get top 20 by degree
        top_ids = sorted(degree, key=degree.get, reverse=True)[:20]

        # Fetch those nodes
        nodes_res = supabase_client.table("nodes").select("id,label,type,description,aliases").in_("id", top_ids).execute()
        nodes = {n["id"]: n for n in (nodes_res.data or [])}

        # Build readable map
        parts = []
        parts.append("KEY ENTITIES (by connection count):")
        for eid in top_ids:
            node = nodes.get(eid, {})
            label = node.get("label", eid)
            etype = node.get("type", "UNKNOWN")
            desc = node.get("description", "")[:150]
            aliases = ", ".join(node.get("aliases", [])[:3])
            parts.append(f"  - {label} [{etype}] (degree: {degree[eid]})")
            if desc:
                parts.append(f"    Description: {desc}")
            if aliases:
                parts.append(f"    Aliases: {aliases}")

        # Include edges between top entities
        top_set = set(top_ids)
        relevant_edges = [e for e in edges if e["source"] in top_set or e["target"] in top_set]

        parts.append(f"\nRELATIONSHIPS ({len(relevant_edges)} involving key entities):")
        for e in relevant_edges[:60]:
            src_label = nodes.get(e["source"], {}).get("label", e["source"])
            tgt_label = nodes.get(e["target"], {}).get("label", e["target"])
            evidence = (e.get("evidence_text") or "")[:200]
            parts.append(f"  {src_label} --[{e['predicate']}]--> {tgt_label}")
            if evidence:
                parts.append(f"    Evidence: {evidence}")

        return "\n".join(parts)
    except Exception as e:
        print(f"DEBUG: Entity map build failed: {e}")
        return ""


def _sample_documents(genai_client, pinecone_index, semantic_search_fn):
    """Sample high-relevance document chunks across investigative topics."""
    topics = [
        "financial transactions wire transfers payments",
        "shell companies offshore accounts corporate structure",
        "travel records flights meetings",
        "legal proceedings allegations criminal",
        "contracts agreements beneficial ownership",
    ]

    all_chunks = {}
    for topic in topics:
        try:
            results = semantic_search_fn(
                query_text=topic,
                genai_client=genai_client,
                pinecone_index=pinecone_index,
                rerank_fn=None,
                fetch_k=30,
                rerank_top_n=4,
            )
            if results:
                for c in results:
                    sig = c.get("text", "")[:200]
                    if sig and sig not in all_chunks:
                        all_chunks[sig] = c
        except Exception as e:
            print(f"DEBUG: Document sample for '{topic}' failed: {e}")

    if not all_chunks:
        return ""

    parts = []
    for c in list(all_chunks.values())[:20]:
        filename = c.get("filename", "unknown")
        page = c.get("page", "?")
        text = c.get("text", "")[:800]
        parts.append(f"[Source: {filename}, Page: {page}]\n{text}")

    return "\n\n---\n\n".join(parts)

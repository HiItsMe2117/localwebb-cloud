"""
Build comprehensive knowledge graph from all indexed documents.

Downloads all vector text from Pinecone, sends each document through
Gemini 2.0 Flash for entity+relationship extraction, deduplicates
entities, and saves a ReactFlow-compatible graph to GCS.

Usage:
    python3 scripts/build_graph.py                  # Full build
    python3 scripts/build_graph.py --resume         # Resume from progress file
    python3 scripts/build_graph.py --dry-run        # Extract + print stats, don't save to GCS
    python3 scripts/build_graph.py --skip-dedup     # Skip Gemini dedup pass (heuristic only)
"""

import os
import sys
import json
import math
import time
import re
import tempfile
import argparse
from pathlib import Path
from collections import defaultdict
from typing import List, Optional
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "graph_build_progress.json"

GEMINI_DELAY = 1.0          # seconds between Gemini calls (rate limit)
MAX_RETRIES = 2              # retries per document on failure
PINECONE_FETCH_BATCH = 100   # vectors per Pinecone fetch call
MAX_DOC_CHARS = 30_000       # truncate documents longer than this


# ---------------------------------------------------------------------------
# Env + progress helpers (same pattern as reindex.py)
# ---------------------------------------------------------------------------
def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v.strip('"').replace("\\n", "").strip()
    return env


def load_progress():
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {"completed": [], "raw_entities": [], "raw_triples": []}


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def format_time(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    elif seconds < 3600:
        return f"{seconds // 60:.0f}m {seconds % 60:.0f}s"
    else:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        return f"{h:.0f}h {m:.0f}m"


# ---------------------------------------------------------------------------
# Pydantic models (copied from api/index.py to avoid FastAPI import side effects)
# ---------------------------------------------------------------------------
class Entity(BaseModel):
    id: str
    label: str
    type: str   # PERSON, ORGANIZATION, LOCATION, EVENT, DOCUMENT, FINANCIAL_ENTITY
    description: str
    aliases: List[str] = []


class Triple(BaseModel):
    subject_id: str
    predicate: str
    object_id: str
    evidence_text: str
    source_filename: str
    source_page: int = 0
    confidence: str = "STATED"
    date_mentioned: Optional[str] = None


class CaseMap(BaseModel):
    entities: List[Entity]
    triples: List[Triple]


# ---------------------------------------------------------------------------
# Phase 1: Collect document text from Pinecone
# ---------------------------------------------------------------------------
def collect_documents(pinecone_index):
    """Fetch all vectors from Pinecone and group by document filename."""
    print("\n" + "=" * 60)
    print("PHASE 1: Collecting document text from Pinecone")
    print("=" * 60)

    # Enumerate all vector IDs via paginated listing
    print("  Enumerating vector IDs...")
    all_ids = []
    pagination_token = None
    while True:
        kwargs = {}
        if pagination_token:
            kwargs["pagination_token"] = pagination_token
        page = pinecone_index.list_paginated(**kwargs)
        if page.vectors:
            all_ids.extend([v.id for v in page.vectors])
        if not page.pagination or not page.pagination.next:
            break
        pagination_token = page.pagination.next
        if len(all_ids) % 1000 < PINECONE_FETCH_BATCH:
            print(f"    {len(all_ids)} IDs enumerated...")

    print(f"  Total vectors: {len(all_ids)}")

    # Fetch metadata in batches
    print("  Fetching metadata...")
    documents = defaultdict(lambda: {"chunks": []})

    for i in range(0, len(all_ids), PINECONE_FETCH_BATCH):
        batch_ids = all_ids[i:i + PINECONE_FETCH_BATCH]
        result = pinecone_index.fetch(ids=batch_ids)

        for vec_id, vec_data in result.vectors.items():
            meta = vec_data.metadata or {}

            # Extract text (handle both legacy _node_content and current text field)
            text = ""
            if '_node_content' in meta:
                try:
                    text = json.loads(meta['_node_content']).get('text', '')
                except (json.JSONDecodeError, TypeError):
                    pass
            if not text:
                text = meta.get('text', '')

            filename = meta.get('filename', 'unknown')
            page = meta.get('page', 0)
            chunk_index = meta.get('chunk_index', 0)

            if text.strip():
                documents[filename]["chunks"].append({
                    "text": text.strip(),
                    "page": page,
                    "chunk_index": chunk_index,
                })

        fetched = min(i + PINECONE_FETCH_BATCH, len(all_ids))
        if fetched % 500 < PINECONE_FETCH_BATCH:
            print(f"    Fetched {fetched}/{len(all_ids)} vectors...")

    # Sort chunks by chunk_index and build full text with page markers
    for filename, doc in documents.items():
        doc["chunks"].sort(key=lambda c: c["chunk_index"])
        parts = []
        current_page = None
        for chunk in doc["chunks"]:
            if chunk["page"] != current_page:
                current_page = chunk["page"]
                parts.append(f"\n[Page {current_page}]\n")
            parts.append(chunk["text"])
        doc["text"] = "\n".join(parts)

    print(f"  Documents assembled: {len(documents)}")
    total_chars = sum(len(d["text"]) for d in documents.values())
    print(f"  Total text: {total_chars:,} characters")

    return dict(documents)


# ---------------------------------------------------------------------------
# Phase 2: Extract entities + triples via Gemini 2.0 Flash
# ---------------------------------------------------------------------------
EXTRACTION_PROMPT = (
    "You are an investigative intelligence analyst. Extract entities and their relationships from this document.\n\n"
    "RULES:\n"
    "1. Every entity needs an id (lowercase_snake_case), a label (display name), "
    "a type (PERSON, ORGANIZATION, LOCATION, EVENT, DOCUMENT, FINANCIAL_ENTITY), a description, and aliases (alternate names).\n"
    "2. Every relationship (triple) MUST include:\n"
    "   - subject_id and object_id referencing entity ids\n"
    "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
    "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
    "   - source_filename: '{filename}'\n"
    "   - source_page: the page number from the [Page N] markers\n"
    "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
    "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, null otherwise\n"
    "3. Do NOT invent relationships that aren't supported by the text.\n"
    "4. Extract as many entities and relationships as the documents support.\n\n"
    "DOCUMENT ({filename}):\n{text}\n\n"
    "Return JSON with 'entities' and 'triples' keys."
)


def extract_from_documents(genai_client, types, documents, progress, resume=False):
    """Send each document to Gemini 2.0 Flash for entity+triple extraction."""
    print("\n" + "=" * 60)
    print("PHASE 2: Extracting entities and triples")
    print("=" * 60)

    completed_set = set(progress["completed"])
    filenames = sorted(documents.keys())

    if resume:
        remaining = [f for f in filenames if f not in completed_set]
        print(f"  Resuming: {len(completed_set)} done, {len(remaining)} remaining")
    else:
        remaining = filenames
        progress["completed"] = []
        progress["raw_entities"] = []
        progress["raw_triples"] = []

    total = len(remaining)
    if total == 0:
        print("  Nothing to extract (all documents already processed)")
        return

    for idx, filename in enumerate(remaining):
        doc = documents[filename]
        text = doc["text"]

        # Skip documents with very little text
        if len(text.strip()) < 100:
            print(f"  [{idx+1}/{total}] {filename} — skipping (too short: {len(text)} chars)")
            progress["completed"].append(filename)
            save_progress(progress)
            continue

        # Truncate very long documents to fit context window
        if len(text) > MAX_DOC_CHARS:
            text = text[:MAX_DOC_CHARS] + "\n...[truncated]"

        print(f"  [{idx+1}/{total}] {filename} ({len(text):,} chars)", end="", flush=True)

        prompt = EXTRACTION_PROMPT.format(filename=filename, text=text)

        success = False
        for attempt in range(MAX_RETRIES + 1):
            try:
                time.sleep(GEMINI_DELAY)
                res = genai_client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=CaseMap,
                    )
                )
                output = res.parsed

                entities = [e.model_dump() for e in output.entities]
                triples = [t.model_dump() for t in output.triples]

                progress["raw_entities"].extend(entities)
                progress["raw_triples"].extend(triples)
                progress["completed"].append(filename)
                save_progress(progress)

                print(f" → {len(entities)} entities, {len(triples)} triples")
                success = True
                break

            except Exception as e:
                if attempt < MAX_RETRIES:
                    wait = (attempt + 1) * 5
                    print(f"\n    Retry {attempt+1} (waiting {wait}s): {e}")
                    time.sleep(wait)
                else:
                    print(f"\n    FAILED after {MAX_RETRIES + 1} attempts: {e}")

        if not success:
            # Still mark as completed to avoid infinite retry loops on bad docs
            progress["completed"].append(filename)
            save_progress(progress)

    print(f"\n  Extraction complete:")
    print(f"    Documents processed: {len(progress['completed'])}")
    print(f"    Raw entities: {len(progress['raw_entities'])}")
    print(f"    Raw triples: {len(progress['raw_triples'])}")


# ---------------------------------------------------------------------------
# Phase 3: Deduplicate entities
# ---------------------------------------------------------------------------
def deduplicate_entities(genai_client, types, progress, skip_gemini=False):
    """Two-pass deduplication: heuristic merge then optional Gemini fuzzy merge."""
    print("\n" + "=" * 60)
    print("PHASE 3: Deduplicating entities")
    print("=" * 60)

    raw_entities = progress["raw_entities"]
    raw_triples = progress["raw_triples"]

    print(f"  Input: {len(raw_entities)} raw entities, {len(raw_triples)} raw triples")

    # --- Pass 1: Heuristic merge ---
    print("\n  Pass 1: Heuristic merge...")

    def normalize(s):
        return re.sub(r'[^a-z0-9\s]', '', s.lower()).strip()

    # Group by (normalized_label, type)
    groups = defaultdict(list)
    for ent in raw_entities:
        key = (normalize(ent["label"]), ent["type"].upper())
        groups[key].append(ent)

    # Merge each group into a canonical entity
    merged_entities = {}   # canonical_id → merged entity dict
    id_remap = {}          # any old_id → canonical_id

    for (norm_label, etype), group in groups.items():
        # Pick canonical: longest description
        group.sort(key=lambda e: len(e.get("description", "")), reverse=True)
        canonical = group[0].copy()

        # Collect all aliases and IDs
        all_aliases = set()
        all_ids = set()
        for ent in group:
            all_aliases.add(ent["label"])
            all_aliases.update(ent.get("aliases", []))
            all_ids.add(ent["id"])

        all_aliases.discard(canonical["label"])
        canonical["aliases"] = sorted(all_aliases)

        for old_id in all_ids:
            id_remap[old_id] = canonical["id"]

        merged_entities[canonical["id"]] = canonical

    print(f"    {len(raw_entities)} raw → {len(merged_entities)} merged entities")

    # --- Pass 2: Gemini fuzzy merge ---
    if not skip_gemini and len(merged_entities) > 10:
        print("\n  Pass 2: Gemini fuzzy merge...")

        entity_list = []
        for ent in merged_entities.values():
            aliases_str = ", ".join(ent.get("aliases", [])[:5])
            entity_list.append(
                f"{ent['id']} | {ent['label']} | {ent['type']} | aliases: {aliases_str}"
            )

        batch_size = 500
        all_merge_groups = []

        for i in range(0, len(entity_list), batch_size):
            batch = entity_list[i:i + batch_size]
            batch_text = "\n".join(batch)

            merge_prompt = (
                "You are deduplicating a knowledge graph. Below is a list of entities "
                "(id | label | type | aliases).\n"
                "Identify groups of entities that refer to the SAME real-world entity "
                "and should be merged.\n"
                "Only group entities that are clearly the same (e.g., 'FBI' and "
                "'Federal Bureau of Investigation', 'Les Wexner' and 'Leslie Wexner').\n"
                "Do NOT merge entities that are merely related.\n\n"
                f"ENTITIES:\n{batch_text}\n\n"
                "Return a JSON array of merge groups. Each group is an array of entity "
                "IDs to merge.\n"
                "Example: [[\"id_1\", \"id_2\"], [\"id_3\", \"id_4\", \"id_5\"]]\n"
                "If no merges needed, return an empty array: []"
            )

            try:
                time.sleep(GEMINI_DELAY)
                res = genai_client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=merge_prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                    )
                )
                groups = json.loads(res.text)
                if isinstance(groups, list):
                    all_merge_groups.extend(groups)
                    print(f"    Batch {i // batch_size + 1}: found {len(groups)} merge groups")
            except Exception as e:
                print(f"    Batch {i // batch_size + 1} failed: {e}")

        # Apply Gemini merge groups
        gemini_merges = 0
        for group in all_merge_groups:
            if not isinstance(group, list) or len(group) < 2:
                continue
            valid_ids = [eid for eid in group if eid in merged_entities]
            if len(valid_ids) < 2:
                continue

            # Pick canonical (longest description)
            valid_ids.sort(
                key=lambda eid: len(merged_entities[eid].get("description", "")),
                reverse=True,
            )
            canonical_id = valid_ids[0]
            canonical = merged_entities[canonical_id]

            for other_id in valid_ids[1:]:
                other = merged_entities.pop(other_id)

                # Merge aliases
                aliases = set(canonical.get("aliases", []))
                aliases.add(other["label"])
                aliases.update(other.get("aliases", []))
                aliases.discard(canonical["label"])
                canonical["aliases"] = sorted(aliases)

                # Keep longer description
                if len(other.get("description", "")) > len(canonical.get("description", "")):
                    canonical["description"] = other["description"]

                # Update id_remap: anything that pointed to other_id now points to canonical_id
                for k, v in list(id_remap.items()):
                    if v == other_id:
                        id_remap[k] = canonical_id
                id_remap[other_id] = canonical_id
                gemini_merges += 1

        print(f"    Gemini merge: removed {gemini_merges} duplicate entities")
        print(f"    After Gemini merge: {len(merged_entities)} entities")

    # --- Remap triple IDs and deduplicate ---
    print("\n  Remapping triple IDs...")
    remapped_triples = []
    dropped = 0
    for triple in raw_triples:
        t = triple.copy()
        t["subject_id"] = id_remap.get(t["subject_id"], t["subject_id"])
        t["object_id"] = id_remap.get(t["object_id"], t["object_id"])

        # Only keep triples whose entities exist and aren't self-loops
        if (t["subject_id"] in merged_entities
                and t["object_id"] in merged_entities
                and t["subject_id"] != t["object_id"]):
            remapped_triples.append(t)
        else:
            dropped += 1

    # Deduplicate triples (same subject + predicate + object)
    seen = set()
    unique_triples = []
    for t in remapped_triples:
        key = (t["subject_id"], t["predicate"], t["object_id"])
        if key not in seen:
            seen.add(key)
            unique_triples.append(t)

    print(f"    {len(raw_triples)} raw → {len(remapped_triples)} valid → {len(unique_triples)} unique ({dropped} dropped)")
    print(f"\n  Final: {len(merged_entities)} entities, {len(unique_triples)} triples")

    return list(merged_entities.values()), unique_triples


# ---------------------------------------------------------------------------
# Phase 4: Build ReactFlow graph and save to GCS
# ---------------------------------------------------------------------------
def build_and_save_graph(env, entities, triples, dry_run=False, supabase_client=None):
    """Convert to ReactFlow format, run community detection, save to GCS and/or Supabase."""
    print("\n" + "=" * 60)
    print("PHASE 4: Building and saving graph")
    print("=" * 60)

    # Build ReactFlow nodes with circular layout
    total = len(entities)
    cx, cy = 400, 400
    radius = max(200, total * 15)

    nodes = []
    entity_ids = set()
    for i, ent in enumerate(entities):
        angle = (2 * math.pi * i) / max(total, 1)
        entity_ids.add(ent["id"])
        nodes.append({
            "id": ent["id"],
            "type": "entityNode",
            "data": {
                "label": ent["label"],
                "entityType": ent["type"].upper(),
                "description": ent.get("description", ""),
                "aliases": ent.get("aliases", []),
            },
            "position": {
                "x": cx + radius * math.cos(angle),
                "y": cy + radius * math.sin(angle),
            },
        })

    # Build ReactFlow edges
    edges = []
    for triple in triples:
        if triple["subject_id"] not in entity_ids or triple["object_id"] not in entity_ids:
            continue
        edge_id = f"e-{triple['subject_id']}-{triple['predicate']}-{triple['object_id']}"
        edges.append({
            "id": edge_id,
            "source": triple["subject_id"],
            "target": triple["object_id"],
            "label": triple["predicate"].replace("_", " "),
            "animated": triple.get("confidence") == "INFERRED",
            "style": {"strokeDasharray": "5 5"} if triple.get("confidence") == "INFERRED" else {},
            "data": {
                "predicate": triple["predicate"],
                "evidence_text": triple.get("evidence_text", ""),
                "source_filename": triple.get("source_filename", ""),
                "source_page": triple.get("source_page", 0),
                "confidence": triple.get("confidence", "STATED"),
                "date_mentioned": triple.get("date_mentioned"),
            },
        })

    # Calculate node degrees
    degree = defaultdict(int)
    for edge in edges:
        degree[edge["source"]] += 1
        degree[edge["target"]] += 1
    for node in nodes:
        node["data"]["degree"] = degree.get(node["id"], 0)

    graph_data = {"nodes": nodes, "edges": edges}
    print(f"  Graph: {len(nodes)} nodes, {len(edges)} edges")

    # Community detection via existing graph_ops
    sys.path.insert(0, str(PROJECT_DIR))
    try:
        from api.graph_ops import compute_communities
        graph_data = compute_communities(graph_data)
    except Exception as e:
        print(f"  Warning: Community detection failed: {e}")

    # Entity type breakdown
    type_counts = defaultdict(int)
    for n in nodes:
        type_counts[n["data"]["entityType"]] += 1
    print("  Entity types:")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {t}: {c}")

    # Top connected nodes
    top_nodes = sorted(nodes, key=lambda n: n["data"].get("degree", 0), reverse=True)[:10]
    if top_nodes:
        print("  Top connected entities:")
        for n in top_nodes:
            print(f"    {n['data']['label']}: {n['data'].get('degree', 0)} connections")

    if dry_run:
        print("\n  DRY RUN — not saving")
        return graph_data

    # --- Supabase upsert ---
    if supabase_client:
        try:
            print("\n  Upserting to Supabase...")

            # Prepare node records (deduplicate by id)
            node_records = {}
            for node in graph_data["nodes"]:
                nid = node["id"]
                node_records[nid] = {
                    "id": nid,
                    "label": node["data"].get("label", nid),
                    "type": node["data"].get("entityType", "UNKNOWN"),
                    "description": node["data"].get("description", ""),
                    "aliases": node["data"].get("aliases", []),
                    "position": node.get("position", {"x": 0, "y": 0}),
                    "metadata": {
                        "degree": node["data"].get("degree", 0),
                        "communityId": node["data"].get("communityId"),
                        "communityColor": node["data"].get("communityColor"),
                    },
                }
            node_list = list(node_records.values())

            # Prepare edge records (deduplicate by id)
            edge_records = {}
            for edge in graph_data["edges"]:
                eid = edge["id"]
                if eid not in edge_records:
                    edge_records[eid] = {
                        "id": eid,
                        "source": edge["source"],
                        "target": edge["target"],
                        "label": edge.get("label", edge["data"]["predicate"]),
                        "predicate": edge["data"]["predicate"],
                        "evidence_text": edge["data"].get("evidence_text", ""),
                        "source_filename": edge["data"].get("source_filename", ""),
                        "source_page": edge["data"].get("source_page", 0),
                        "confidence": edge["data"].get("confidence", "STATED"),
                        "date_mentioned": edge["data"].get("date_mentioned"),
                    }
            edge_list = list(edge_records.values())

            # Clear existing tables (edges first due to FK constraint)
            print("    Clearing existing edges...")
            supabase_client.table("edges").delete().neq("id", "").execute()
            print("    Clearing existing nodes...")
            supabase_client.table("nodes").delete().neq("id", "").execute()

            # Batch upsert nodes (must come before edges for FK)
            BATCH_SIZE = 50
            for i in range(0, len(node_list), BATCH_SIZE):
                batch = node_list[i:i + BATCH_SIZE]
                supabase_client.table("nodes").upsert(batch, on_conflict="id").execute()
                done = min(i + BATCH_SIZE, len(node_list))
                if done % 200 < BATCH_SIZE or done == len(node_list):
                    print(f"    Nodes: {done}/{len(node_list)}")

            # Batch upsert edges
            for i in range(0, len(edge_list), BATCH_SIZE):
                batch = edge_list[i:i + BATCH_SIZE]
                supabase_client.table("edges").upsert(batch, on_conflict="id").execute()
                done = min(i + BATCH_SIZE, len(edge_list))
                if done % 200 < BATCH_SIZE or done == len(edge_list):
                    print(f"    Edges: {done}/{len(edge_list)}")

            print(f"  Supabase complete: {len(node_list)} nodes, {len(edge_list)} edges")
        except Exception as e:
            print(f"  ERROR: Supabase upsert failed: {e}")
            import traceback; traceback.print_exc()

    # Upload to GCS (replace graph_store.json)
    try:
        print("\n  Uploading graph_store.json to GCS...")
        from google.cloud import storage as gcs
        storage_client = gcs.Client()
        bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])
        blob = bucket.blob("graph_store.json")

        graph_json = json.dumps(graph_data, indent=2)
        blob.upload_from_string(graph_json, content_type="application/json")

        print(f"  Saved to GCS ({len(graph_json):,} bytes)")
    except Exception as e:
        print(f"  GCS save failed (non-critical): {e}")

    return graph_data


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Build comprehensive knowledge graph from all indexed documents"
    )
    parser.add_argument("--resume", action="store_true",
                        help="Resume from progress file, skip completed documents")
    parser.add_argument("--dry-run", action="store_true",
                        help="Extract + print stats, don't save to GCS")
    parser.add_argument("--skip-dedup", action="store_true",
                        help="Skip Gemini dedup pass (heuristic only)")
    parser.add_argument("--supabase", action="store_true",
                        help="Upsert final graph to Supabase (replaces existing data)")
    args = parser.parse_args()

    print("=" * 60)
    print("Knowledge Graph Builder")
    print("=" * 60)

    start_time = time.time()

    # Load env
    env = load_env()

    # Set up GCP credentials
    gcp_json = env.get("GCP_SERVICE_ACCOUNT_JSON", "")
    if gcp_json:
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write(gcp_json)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

    # Initialize clients
    from google import genai
    from google.genai import types
    from pinecone import Pinecone

    genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    pinecone_index = pc.Index("localwebb")

    supabase_client = None
    if args.supabase:
        from supabase import create_client
        supabase_client = create_client(
            env["SUPABASE_URL"].strip(), env["SUPABASE_SERVICE_KEY"].strip()
        )
        print(f"  Supabase client initialized")

    # Load or reset progress
    if args.resume:
        progress = load_progress()
        print(f"Loaded progress: {len(progress['completed'])} docs, "
              f"{len(progress['raw_entities'])} entities, "
              f"{len(progress['raw_triples'])} triples")
    else:
        progress = {"completed": [], "raw_entities": [], "raw_triples": []}

    # Phase 1: Collect text from Pinecone
    documents = collect_documents(pinecone_index)

    # Phase 2: Extract entities + triples
    extract_from_documents(genai_client, types, documents, progress, resume=args.resume)

    # Phase 3: Deduplicate
    entities, triples = deduplicate_entities(
        genai_client, types, progress, skip_gemini=args.skip_dedup
    )

    # Phase 4: Build and save graph
    graph_data = build_and_save_graph(
        env, entities, triples, dry_run=args.dry_run, supabase_client=supabase_client
    )

    # Summary
    elapsed = time.time() - start_time
    print("\n" + "=" * 60)
    print("BUILD COMPLETE")
    print("=" * 60)
    print(f"  Total time:    {format_time(elapsed)}")
    print(f"  Documents:     {len(progress['completed'])}")
    print(f"  Entities:      {len(entities)}")
    print(f"  Triples:       {len(triples)}")
    print(f"  Graph nodes:   {len(graph_data['nodes'])}")
    print(f"  Graph edges:   {len(graph_data['edges'])}")
    if "communities" in graph_data:
        print(f"  Communities:   {len(graph_data['communities'])}")
    print(f"\nProgress saved to: {PROGRESS_FILE}")


if __name__ == "__main__":
    main()

"""
Bulk entity/relationship extraction for knowledge graph.

Reads document text from Pinecone metadata, extracts entities and
relationships via Gemini 2.0 Flash, and upserts incrementally to
Supabase nodes/edges tables.

Usage:
    python3 scripts/bulk_extract.py                # Full run
    python3 scripts/bulk_extract.py --resume       # Resume from progress
    python3 scripts/bulk_extract.py --test         # Process 1 file only
    python3 scripts/bulk_extract.py --dataset 9,11 # Filter by dataset
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
from datetime import datetime, timezone
from typing import List, Optional
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "bulk_extract_progress.json"
PINECONE_FILENAMES_FILE = SCRIPT_DIR / "pinecone_filenames.json"

GEMINI_DELAY = 1.0           # seconds between Gemini calls
MAX_RETRIES = 2              # retries per document
PINECONE_FETCH_BATCH = 100   # vectors per Pinecone fetch
MAX_DOC_CHARS = 80_000       # max chars sent to Gemini
PROGRESS_UPLOAD_INTERVAL = 20  # upload live progress every N files
PAUSE_CHECK_INTERVAL = 30    # seconds between pause signal checks

# Rate limit tracking
_rate_limit_events = []
_rate_limit_count = 0
RATE_LIMIT_WINDOW = 300      # 5 minutes
RATE_LIMIT_THRESHOLD = 3     # auto-pause after this many 429s


# ---------------------------------------------------------------------------
# Pydantic models (same as api/index.py)
# ---------------------------------------------------------------------------
class Entity(BaseModel):
    id: str
    label: str
    type: str
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
# Extraction prompt (same as api/index.py EXTRACTION_PROMPT_TEMPLATE)
# ---------------------------------------------------------------------------
EXTRACTION_PROMPT = (
    "You are an investigative intelligence analyst. Extract entities and their relationships from these documents.\n\n"
    "RULES:\n"
    "1. Every entity needs an id (lowercase_snake_case), a label (display name), a type (PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY), a description, and aliases (alternate names).\n"
    "2. Every relationship (triple) MUST include:\n"
    "   - subject_id and object_id referencing entity ids\n"
    "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
    "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
    "   - source_filename: the filename from the [Source: ...] header\n"
    "   - source_page: the page number from the [Source: ...] header\n"
    "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
    "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, empty string otherwise\n"
    "3. Do NOT use generic legal roles (e.g., 'THE WITNESS', 'THE DEFENDANT', 'THE AGENT', 'COUNSEL') as aliases. Instead, use the document context (headers, questions) to resolve these roles to the specific named entity they refer to.\n"
    "4. Do NOT invent relationships that aren't supported by the text.\n"
    "5. QUALITY OVER QUANTITY — only extract entities that are meaningful and identifiable:\n"
    "   - Do NOT create entities for document filenames or IDs (e.g., 'EFTA02341172', 'Exhibit A')\n"
    "   - Do NOT create entities for single initials or 1-2 character labels (e.g., 'G', 'JJ', 'MM') unless you can resolve them to a full name\n"
    "   - Do NOT create entities for generic or unidentifiable references (e.g., 'unknown person', 'a friend', 'the driver')\n"
    "   - Every entity MUST have a meaningful description that explains WHO/WHAT they are — not just 'mentioned in the document'\n"
    "   - Only create an entity if it has at least one meaningful relationship to another entity\n"
    "6. ENTITY TYPES — use only: PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY. Do NOT use DOCUMENT, OBJECT, VEHICLE, DEVICE, or other types.\n"
    "7. PREFER EXISTING ENTITIES — if an entity likely refers to someone/something already well-known (e.g., a head of state, major company), use the most recognized full name as the label.\n\n"
    "DOCUMENTS:\n{context}\n\n"
    "Return JSON with 'entities' and 'triples' keys."
)


# ---------------------------------------------------------------------------
# Quality gate (same as api/index.py)
# ---------------------------------------------------------------------------
_DOC_ID_RE = re.compile(r'^e[a-z]?[fpuh]?ta\d', re.IGNORECASE)
_GENERIC_DESC_RE = re.compile(
    r'^(a |an )?(person|individual|entity|organization|document|location|someone|something)?\s*'
    r'(mentioned|referenced|noted|found|listed|described)\s*(in|within)',
    re.IGNORECASE
)
_BAD_ENTITY_TYPES = {"DOCUMENT", "OBJECT", "VEHICLE", "DEVICE"}


def filter_quality_entities(entities):
    quality = []
    for ent in entities:
        label = ent.label.strip()
        if len(label) <= 2:
            continue
        if _DOC_ID_RE.match(label) or _DOC_ID_RE.match(ent.id):
            continue
        if ent.type.upper() in _BAD_ENTITY_TYPES:
            continue
        if _GENERIC_DESC_RE.match(ent.description.strip()) and len(ent.description) < 60:
            continue
        quality.append(ent)
    return quality


# ---------------------------------------------------------------------------
# Helpers
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
    return {"completed": [], "failed": [], "entities_added": 0, "triples_added": 0}


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def is_rate_limit_error(e):
    s = str(e).lower()
    return "429" in s or "resource_exhausted" in s or "rate" in s


def track_rate_limit():
    global _rate_limit_count, _rate_limit_events
    now = time.time()
    _rate_limit_count += 1
    _rate_limit_events.append(now)
    _rate_limit_events = [t for t in _rate_limit_events if now - t < RATE_LIMIT_WINDOW]
    return len(_rate_limit_events) >= RATE_LIMIT_THRESHOLD


def check_control_signal(bucket):
    try:
        blob = bucket.blob("bulk_extract_control.json")
        if blob.exists():
            data = json.loads(blob.download_as_text())
            return data.get("command", "run")
    except Exception:
        pass
    return "run"


def upload_live_progress(bucket, files_completed, files_failed, total_files,
                         entities_added, triples_added, start_time,
                         active=True, files_this_run=0, paused=False,
                         pause_reason=None):
    try:
        blob = bucket.blob("bulk_extract_live_progress.json")
        data = {
            "active": active,
            "paused": paused,
            "pause_reason": pause_reason,
            "rate_limit_count": _rate_limit_count,
            "files_completed": files_completed,
            "files_failed": files_failed,
            "total_files": total_files,
            "entities_added": entities_added,
            "triples_added": triples_added,
            "started_at": start_time,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "files_this_run": files_this_run,
        }
        blob.upload_from_string(json.dumps(data), content_type="application/json")
    except Exception:
        pass


def fetch_file_text_from_pinecone(pinecone_index, filename):
    """Fetch all chunks for a file from Pinecone and assemble text."""
    # List vector IDs matching this filename
    all_ids = []
    for ids in pinecone_index.list(prefix=filename):
        all_ids.extend(ids)

    if not all_ids:
        return None

    # Fetch metadata in batches
    chunks = []
    for i in range(0, len(all_ids), PINECONE_FETCH_BATCH):
        batch_ids = all_ids[i:i + PINECONE_FETCH_BATCH]
        result = pinecone_index.fetch(ids=batch_ids)
        for vec_id, vec_data in result.vectors.items():
            meta = vec_data.metadata or {}
            text = meta.get("text", "")
            if not text and "_node_content" in meta:
                try:
                    text = json.loads(meta["_node_content"]).get("text", "")
                except (json.JSONDecodeError, TypeError):
                    pass
            page = meta.get("page", 0)
            chunk_index = meta.get("chunk_index", 0)
            if text.strip():
                chunks.append({"text": text.strip(), "page": page, "chunk_index": chunk_index})

    if not chunks:
        return None

    # Sort by chunk_index and assemble
    chunks.sort(key=lambda c: c["chunk_index"])
    parts = []
    for chunk in chunks:
        parts.append(f"[Source: {filename}, Page: {chunk['page']}]\n{chunk['text']}")

    return "\n\n---\n\n".join(parts)


def upsert_to_supabase(supabase_client, quality_entities, triples):
    """Upsert extracted entities and relationships to Supabase."""
    entity_ids = {ent.id for ent in quality_entities}

    # Build node records
    node_records = []
    total = len(quality_entities)
    for i, ent in enumerate(quality_entities):
        node_records.append({
            "id": ent.id,
            "label": ent.label,
            "type": ent.type.upper(),
            "description": ent.description,
            "aliases": ent.aliases,
            "position": {"x": 0, "y": 0},
            "metadata": {},
        })

    # Build edge records (only for edges connecting quality entities)
    edge_records = []
    seen_edge_ids = set()
    for triple in triples:
        if triple.subject_id not in entity_ids or triple.object_id not in entity_ids:
            continue
        edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
        if edge_id in seen_edge_ids:
            continue
        seen_edge_ids.add(edge_id)

        # Fix hallucinated filename
        fname = triple.source_filename
        if not fname.endswith(".pdf"):
            fname += ".pdf"
        fname = fname.replace(".pdf.pdf", ".pdf")

        edge_records.append({
            "id": edge_id,
            "source": triple.subject_id,
            "target": triple.object_id,
            "label": triple.predicate.replace("_", " "),
            "predicate": triple.predicate,
            "evidence_text": triple.evidence_text,
            "source_filename": fname,
            "source_page": triple.source_page,
            "confidence": triple.confidence,
            "date_mentioned": triple.date_mentioned or None,
        })

    # Upsert to Supabase
    if node_records:
        for i in range(0, len(node_records), 50):
            batch = node_records[i:i + 50]
            supabase_client.table("nodes").upsert(batch, on_conflict="id").execute()

    if edge_records:
        for i in range(0, len(edge_records), 50):
            batch = edge_records[i:i + 50]
            supabase_client.table("edges").upsert(batch, on_conflict="id").execute()

    return len(node_records), len(edge_records)


def classify_dataset(filename):
    """Classify a file into a dataset number based on filename patterns."""
    name = filename.upper()
    if "DATASET-11" in name or "DATASET11" in name:
        return "11"
    if "DATASET-8" in name or "DATASET8" in name:
        return "8"
    # Most EFTA files are dataset 9 unless in a subdirectory
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Bulk entity extraction for knowledge graph")
    parser.add_argument("--resume", action="store_true", help="Resume from progress file")
    parser.add_argument("--test", action="store_true", help="Process 1 file only")
    parser.add_argument("--dataset", type=str, default=None, help="Filter to specific datasets (e.g., 9,11)")
    args = parser.parse_args()

    print("=" * 60)
    print("Bulk Entity Extraction → Knowledge Graph")
    print("=" * 60)

    env = load_env()

    # Set up GCP credentials
    gcp_json = env.get("GCP_SERVICE_ACCOUNT_JSON", "")
    if gcp_json:
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write(gcp_json)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

    from google import genai
    from google.genai import types
    from google.cloud import storage
    from pinecone import Pinecone
    from supabase import create_client

    genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    pinecone_index = pc.Index("localwebb")
    storage_client = storage.Client()
    bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])
    supabase_client = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])

    # Load all vectorized filenames
    if PINECONE_FILENAMES_FILE.exists():
        all_filenames = set(json.loads(PINECONE_FILENAMES_FILE.read_text()))
        print(f"Loaded {len(all_filenames)} vectorized filenames from cache")
    else:
        print("Listing Pinecone filenames (no cache found)...")
        all_filenames = set()
        for ids in pinecone_index.list():
            for vid in ids:
                parts = vid.rsplit("-chunk-", 1)
                if len(parts) == 2:
                    all_filenames.add(parts[0])
        print(f"Found {len(all_filenames)} unique filenames in Pinecone")

    # Find already-extracted files from edges table
    print("Querying Supabase for already-extracted files...")
    extracted = set()
    offset = 0
    while True:
        res = supabase_client.table("edges").select("source_filename").range(offset, offset + 999).execute()
        if not res.data:
            break
        for row in res.data:
            if row.get("source_filename"):
                extracted.add(row["source_filename"])
        if len(res.data) < 1000:
            break
        offset += 1000
    print(f"Already extracted: {len(extracted)} files")

    # Compute files to process
    to_process = sorted(all_filenames - extracted)

    # Apply dataset filter
    if args.dataset:
        ds_filter = set(args.dataset.split(","))
        filtered = []
        for f in to_process:
            ds = classify_dataset(f)
            if ds in ds_filter:
                filtered.append(f)
        to_process = filtered
        print(f"Dataset filter {ds_filter}: {len(to_process)} files")

    # Load progress and filter
    progress = load_progress() if args.resume else {
        "completed": [], "failed": [], "entities_added": 0, "triples_added": 0
    }

    if args.resume:
        completed_set = set(progress["completed"])
        to_process = [f for f in to_process if f not in completed_set]
        print(f"Resuming: {len(completed_set)} already done this run")

    if args.test:
        to_process = to_process[:5]
        print(f"TEST MODE: {len(to_process)} files only\n")

    total_files = len(to_process) + len(progress["completed"])
    print(f"\nFiles to process: {len(to_process)}")
    print(f"Total scope: {total_files}")

    if not to_process:
        print("Nothing to process!")
        return

    # Upload initial progress
    start_iso = datetime.now(timezone.utc).isoformat()
    processing_start = time.time()
    files_this_run = 0
    last_pause_check = time.time()

    upload_live_progress(
        bucket, len(progress["completed"]), len(progress["failed"]),
        total_files, progress["entities_added"], progress["triples_added"],
        start_iso, active=True, files_this_run=0
    )

    for idx, filename in enumerate(to_process):
        # Check pause signal periodically
        if time.time() - last_pause_check > PAUSE_CHECK_INTERVAL:
            last_pause_check = time.time()
            cmd = check_control_signal(bucket)
            if cmd == "pause":
                print("\n  PAUSED by control signal")
                upload_live_progress(
                    bucket, len(progress["completed"]), len(progress["failed"]),
                    total_files, progress["entities_added"], progress["triples_added"],
                    start_iso, active=True, paused=True, pause_reason="user_requested",
                    files_this_run=files_this_run
                )
                while check_control_signal(bucket) == "pause":
                    time.sleep(10)
                print("  RESUMED")

        elapsed = time.time() - processing_start
        rate = files_this_run / max(elapsed, 1) * 60
        remaining = len(to_process) - idx
        eta_min = remaining / max(rate, 0.01)
        eta_str = f"{eta_min:.0f}m" if eta_min < 60 else f"{eta_min/60:.1f}h"

        print(f"\n[{idx+1}/{len(to_process)}] {filename} (rate: {rate:.1f}/min, ETA: {eta_str})")

        try:
            # Fetch text from Pinecone
            text = fetch_file_text_from_pinecone(pinecone_index, filename)
            if not text or len(text.strip()) < 100:
                print(f"  Skipped (too short or no text)")
                progress["completed"].append(filename)
                save_progress(progress)
                files_this_run += 1
                continue

            # Truncate if too long
            if len(text) > MAX_DOC_CHARS:
                text = text[:MAX_DOC_CHARS] + "\n...[truncated]"

            # Extract via Gemini
            prompt = EXTRACTION_PROMPT.format(context=text)

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

                    # Quality gate
                    quality_ents = filter_quality_entities(output.entities)
                    entity_ids = {e.id for e in quality_ents}

                    # Filter triples to only reference quality entities
                    quality_triples = [
                        t for t in output.triples
                        if t.subject_id in entity_ids and t.object_id in entity_ids
                    ]

                    # Upsert to Supabase
                    n_nodes, n_edges = upsert_to_supabase(
                        supabase_client, quality_ents, quality_triples
                    )

                    progress["entities_added"] += n_nodes
                    progress["triples_added"] += n_edges
                    progress["completed"].append(filename)
                    save_progress(progress)

                    print(f"  → {n_nodes} entities, {n_edges} relationships "
                          f"(filtered from {len(output.entities)}/{len(output.triples)})")
                    success = True
                    break

                except Exception as e:
                    if is_rate_limit_error(e):
                        exceeded = track_rate_limit()
                        print(f"  Rate limit ({_rate_limit_count}): {e}")
                        if exceeded:
                            print(f"  AUTO-PAUSING ({RATE_LIMIT_THRESHOLD}+ in {RATE_LIMIT_WINDOW}s)")
                            upload_live_progress(
                                bucket, len(progress["completed"]), len(progress["failed"]),
                                total_files, progress["entities_added"], progress["triples_added"],
                                start_iso, active=True, paused=True,
                                pause_reason=f"rate_limited ({_rate_limit_count})",
                                files_this_run=files_this_run
                            )
                            time.sleep(60)  # wait a minute before retrying
                    if attempt < MAX_RETRIES:
                        wait = (attempt + 1) * 5
                        print(f"  Retry {attempt+1} (waiting {wait}s): {e}")
                        time.sleep(wait)
                    else:
                        print(f"  FAILED: {e}")

            if not success:
                progress["failed"].append(filename)
                progress["completed"].append(filename)  # Mark done to avoid infinite loop
                save_progress(progress)

            files_this_run += 1

            # Upload live progress periodically
            if files_this_run % PROGRESS_UPLOAD_INTERVAL == 0:
                upload_live_progress(
                    bucket, len(progress["completed"]), len(progress["failed"]),
                    total_files, progress["entities_added"], progress["triples_added"],
                    start_iso, active=True, files_this_run=files_this_run
                )

        except Exception as e:
            print(f"  ERROR: {e}")
            progress["failed"].append(filename)
            progress["completed"].append(filename)
            save_progress(progress)
            files_this_run += 1

    # Final progress upload
    upload_live_progress(
        bucket, len(progress["completed"]), len(progress["failed"]),
        total_files, progress["entities_added"], progress["triples_added"],
        start_iso, active=False, files_this_run=files_this_run
    )

    elapsed = time.time() - processing_start
    print(f"\n{'='*60}")
    print(f"COMPLETE in {elapsed/3600:.1f}h")
    print(f"  Files processed: {files_this_run}")
    print(f"  Entities added: {progress['entities_added']}")
    print(f"  Relationships added: {progress['triples_added']}")
    print(f"  Failed: {len(progress['failed'])}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

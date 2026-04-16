"""
Upgrade entity metadata from regex (v1) to Gemini extraction (v2).
Updates both Pinecone vector metadata and Supabase document_chunks rows.

Does NOT re-embed or re-chunk — only extracts better metadata from
existing chunk text and patches it in place.

Usage:
    python3 scripts/upgrade_metadata.py              # Full upgrade
    python3 scripts/upgrade_metadata.py --resume      # Resume from progress
    python3 scripts/upgrade_metadata.py --test        # Process 1 file only
    python3 scripts/upgrade_metadata.py --dry-run     # Extract but don't write
    python3 scripts/upgrade_metadata.py --budget       # Show remaining API budget
"""

import os
import sys
import json
import time
import tempfile
import argparse
from pathlib import Path
from collections import defaultdict
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "upgrade_metadata_progress.json"

PINECONE_FETCH_BATCH = 100
MAX_DOC_CHARS = 100_000


# ---------------------------------------------------------------------------
# Env + progress helpers (same pattern as reindex.py / build_graph.py)
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
    return {"completed": [], "failed": [], "calls_made": 0}


def save_progress(progress):
    tmp = PROGRESS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(progress, indent=2))
    tmp.rename(PROGRESS_FILE)


# ---------------------------------------------------------------------------
# Phase 1: Collect document text from Pinecone (reused from build_graph.py)
# ---------------------------------------------------------------------------
def collect_documents(pinecone_index):
    """Fetch all vectors from Pinecone and group by document filename."""
    print("\n" + "=" * 60)
    print("Phase 1: Collecting document text from Pinecone")
    print("=" * 60)

    # Enumerate all vector IDs
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
    documents = defaultdict(lambda: {"chunks": [], "vector_ids": []})

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
            chunk_index = meta.get('chunk_index', 0)
            metadata_version = meta.get('metadata_version', 1)

            if text.strip():
                documents[filename]["chunks"].append({
                    "id": vec_id,
                    "text": text.strip(),
                    "chunk_index": chunk_index,
                    "metadata_version": metadata_version,
                })
                documents[filename]["vector_ids"].append(vec_id)

        fetched = min(i + PINECONE_FETCH_BATCH, len(all_ids))
        if fetched % 500 < PINECONE_FETCH_BATCH:
            print(f"    Fetched {fetched}/{len(all_ids)} vectors...")

    # Sort chunks by chunk_index and build full text
    for filename, doc in documents.items():
        doc["chunks"].sort(key=lambda c: c["chunk_index"])
        doc["text"] = "\n".join(c["text"] for c in doc["chunks"])

    print(f"  Documents assembled: {len(documents)}")
    total_chars = sum(len(d["text"]) for d in documents.values())
    print(f"  Total text: {total_chars:,} characters")

    return dict(documents)


# ---------------------------------------------------------------------------
# Phase 2: Upgrade metadata per file
# ---------------------------------------------------------------------------
def upgrade_file(genai_client, types_module, pinecone_index, supabase_client,
                 filename, doc, rate_limiter, dry_run=False):
    """Extract metadata with Gemini and update both Pinecone and Supabase."""
    from entity_extract import extract_metadata_gemini

    text = doc["text"]
    if len(text.strip()) < 50:
        print(f" -- skipping (too short: {len(text)} chars)")
        return True  # mark as done, nothing to extract

    metadata = extract_metadata_gemini(
        genai_client, types_module, text, filename, rate_limiter
    )
    if metadata is None:
        return False

    people = metadata["people"]
    orgs = metadata["organizations"]
    dates = metadata["dates"]
    locations = metadata["locations"]
    doc_type = metadata["doc_type"]

    print(f" -> {len(people)} people, {len(orgs)} orgs, {len(locations)} locations, type={doc_type}")

    if dry_run:
        return True

    # Update Pinecone metadata (metadata-only, no re-embedding)
    for chunk in doc["chunks"]:
        try:
            pinecone_index.update(
                id=chunk["id"],
                set_metadata={
                    "people": people,
                    "organizations": orgs,
                    "dates": dates,
                    "locations": locations,
                    "doc_type": doc_type,
                    "metadata_version": 2,
                }
            )
        except Exception as e:
            print(f"    Pinecone update failed for {chunk['id']}: {e}")

    # Update Supabase rows
    if supabase_client:
        try:
            for chunk in doc["chunks"]:
                supabase_client.table("document_chunks").update({
                    "people": people,
                    "organizations": orgs,
                    "dates": dates,
                    "locations": locations,
                    "doc_type": doc_type,
                    "metadata_version": 2,
                }).eq("id", chunk["id"]).execute()
        except Exception as e:
            print(f"    Supabase update failed (non-fatal): {e}")

    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Upgrade metadata from regex (v1) to Gemini (v2)")
    parser.add_argument("--resume", action="store_true", help="Resume from progress file")
    parser.add_argument("--test", action="store_true", help="Process only 1 file")
    parser.add_argument("--dry-run", action="store_true", help="Extract but don't write to Pinecone/Supabase")
    parser.add_argument("--budget", action="store_true", help="Show API budget status and exit")
    args = parser.parse_args()

    print("=" * 60)
    print("LocalWebb Cloud — Metadata Upgrade (v1 -> v2)")
    print("=" * 60)

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
    from entity_extract import RateLimiter

    genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    pinecone_index = pc.Index("localwebb")

    # Initialize Supabase
    supabase_client = None
    try:
        sb_url = env.get("SUPABASE_URL", "")
        sb_key = env.get("SUPABASE_SERVICE_KEY", "")
        if sb_url and sb_key:
            from supabase import create_client
            supabase_client = create_client(sb_url, sb_key)
            print("Supabase updates enabled")
        else:
            print("Supabase updates disabled (missing credentials)")
    except Exception as e:
        print(f"Supabase init failed (updates disabled): {e}")

    # Load progress
    progress = load_progress()
    rate_limiter = RateLimiter(rpm=14, rpd=1450)
    rate_limiter.calls_today = progress.get("calls_made", 0)

    if args.budget:
        print(f"\nAPI Budget Status:")
        status = rate_limiter.budget_status()
        for k, v in status.items():
            print(f"  {k}: {v:,}")
        return

    # Collect all documents from Pinecone
    documents = collect_documents(pinecone_index)

    # Filter to files needing upgrade
    completed_set = set(progress["completed"])
    failed_set = set(progress["failed"])
    to_upgrade = []

    for filename, doc in documents.items():
        if filename in completed_set:
            continue
        # Check if any chunk already has metadata_version >= 2
        if any(c.get("metadata_version", 1) >= 2 for c in doc["chunks"]):
            continue
        to_upgrade.append(filename)

    print(f"\n  Files needing upgrade: {len(to_upgrade)}")
    print(f"  Already completed: {len(completed_set)}")
    print(f"  Previously failed: {len(failed_set)}")

    if not to_upgrade:
        print("\n  All files already upgraded!")
        return

    if args.test:
        to_upgrade = to_upgrade[:1]
        print(f"  Test mode: processing 1 file only")

    # Process files
    print("\n" + "=" * 60)
    print("Phase 2: Upgrading metadata")
    print("=" * 60)

    upgraded = 0
    failed = 0
    start_time = time.time()

    for idx, filename in enumerate(tqdm(to_upgrade, desc="Upgrading", unit="file")):
        if not rate_limiter.can_continue():
            elapsed = time.time() - start_time
            print(f"\n  Daily API budget exhausted after {upgraded} files in {elapsed:.0f}s.")
            print(f"  Run again tomorrow with --resume.")
            status = rate_limiter.budget_status()
            for k, v in status.items():
                print(f"    {k}: {v:,}")
            break

        doc = documents[filename]
        tqdm.write(f"  [{idx+1}/{len(to_upgrade)}] {filename} ({len(doc['text']):,} chars)", end="")

        success = upgrade_file(
            genai_client, types, pinecone_index, supabase_client,
            filename, doc, rate_limiter, dry_run=args.dry_run
        )

        if success:
            upgraded += 1
            progress["completed"].append(filename)
        else:
            failed += 1
            progress["failed"].append(filename)

        progress["calls_made"] = rate_limiter.calls_today
        save_progress(progress)

    elapsed = time.time() - start_time
    print(f"\n" + "=" * 60)
    print(f"Metadata upgrade complete")
    print(f"  Upgraded: {upgraded}")
    print(f"  Failed:   {failed}")
    print(f"  Time:     {elapsed:.0f}s")
    print(f"  API calls used today: {rate_limiter.calls_today}")
    if args.dry_run:
        print(f"  (DRY RUN — no changes written)")
    print("=" * 60)


if __name__ == "__main__":
    main()

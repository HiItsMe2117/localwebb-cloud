"""
Backfill document_chunks in Supabase from Pinecone vectors.

One-time migration script. Safe to re-run (idempotent via upsert).

Usage:
    python3 scripts/backfill_chunks.py
"""

import os
import sys
import json
from pathlib import Path
from collections import defaultdict

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"

PINECONE_FETCH_BATCH = 100


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v.strip('"').replace("\\n", "").strip()
    return env


def main():
    env = load_env()

    # Init Pinecone
    from pinecone import Pinecone
    pc_key = env.get("PINECONE_API_KEY") or env.get("PINCONE_API_KEY", "")
    pc_index_name = env.get("PINECONE_INDEX") or env.get("pinecone_index", "")
    if not pc_key or not pc_index_name:
        print("ERROR: Missing PINECONE_API_KEY or PINECONE_INDEX in .env.prod")
        sys.exit(1)
    pc = Pinecone(api_key=pc_key)
    index = pc.Index(pc_index_name)
    print(f"Connected to Pinecone index: {pc_index_name}")

    # Init Supabase
    from supabase import create_client
    sb_url = env.get("SUPABASE_URL", "")
    sb_key = env.get("SUPABASE_SERVICE_KEY", "")
    if not sb_url or not sb_key:
        print("ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.prod")
        sys.exit(1)
    supabase = create_client(sb_url, sb_key)
    print("Connected to Supabase")

    # Step 1: Enumerate all vector IDs
    print("\nEnumerating vector IDs...")
    all_ids = []
    pagination_token = None
    while True:
        kwargs = {}
        if pagination_token:
            kwargs["pagination_token"] = pagination_token
        page = index.list_paginated(**kwargs)
        if page.vectors:
            all_ids.extend([v.id for v in page.vectors])
        if not page.pagination or not page.pagination.next:
            break
        pagination_token = page.pagination.next
        if len(all_ids) % 1000 < PINECONE_FETCH_BATCH:
            print(f"  {len(all_ids)} IDs enumerated...")

    print(f"Total vectors in Pinecone: {len(all_ids)}")

    # Step 2: Fetch metadata in batches and upsert to Supabase
    print("\nFetching metadata and upserting to Supabase...")
    upserted = 0
    skipped = 0
    sb_batch = []
    SB_BATCH_SIZE = 500

    for i in range(0, len(all_ids), PINECONE_FETCH_BATCH):
        batch_ids = all_ids[i:i + PINECONE_FETCH_BATCH]
        result = index.fetch(ids=batch_ids)

        for vec_id, vec_data in result.vectors.items():
            meta = vec_data.metadata or {}

            # Extract text (handle both _node_content and text formats)
            text = ""
            if '_node_content' in meta:
                try:
                    text = json.loads(meta['_node_content']).get('text', '')
                except (json.JSONDecodeError, TypeError):
                    pass
            if not text:
                text = meta.get('text', '')

            if not text.strip():
                skipped += 1
                continue

            filename = meta.get('filename', 'unknown')
            page = meta.get('page', 1)
            chunk_index = meta.get('chunk_index', 0)

            # Ensure page and chunk_index are integers
            try:
                page = int(page)
            except (ValueError, TypeError):
                page = 1
            try:
                chunk_index = int(chunk_index)
            except (ValueError, TypeError):
                chunk_index = 0

            row = {
                "id": vec_id,
                "filename": filename,
                "page": page,
                "chunk_index": chunk_index,
                "text": text.strip(),
                "gcs_path": meta.get('gcs_path'),
                "doc_type": meta.get('doc_type', 'other'),
                "people": meta.get('people', []) or [],
                "organizations": meta.get('organizations', []) or [],
                "dates": meta.get('dates', []) or [],
            }
            sb_batch.append(row)

            if len(sb_batch) >= SB_BATCH_SIZE:
                supabase.table("document_chunks").upsert(sb_batch).execute()
                upserted += len(sb_batch)
                print(f"  Upserted {upserted} rows...")
                sb_batch = []

    # Flush remaining
    if sb_batch:
        supabase.table("document_chunks").upsert(sb_batch).execute()
        upserted += len(sb_batch)

    print(f"\nDone! Upserted {upserted} rows, skipped {skipped} empty vectors.")


if __name__ == "__main__":
    main()

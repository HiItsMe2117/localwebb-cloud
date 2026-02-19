"""
Verify vectorized text chunks in Pinecone.

Fetches and displays the actual text stored for specific file/chunk
combinations, so you can verify that AI-generated citations match
what's actually in the index.

Usage:
    # Fetch a specific chunk by ID
    python3 scripts/verify_vectors.py --id "EFTA00039689.pdf-chunk-82"

    # Fetch multiple chunks
    python3 scripts/verify_vectors.py --id "EFTA00039689.pdf-chunk-82" "EFTA00039689.pdf-chunk-116"

    # Search for a keyword within a specific file's chunks
    python3 scripts/verify_vectors.py --file EFTA00039689.pdf --search "Milken"

    # List all chunks for a file (shows first 100 chars of each)
    python3 scripts/verify_vectors.py --file EFTA00039689.pdf --list

    # Show metadata for a chunk (without full text)
    python3 scripts/verify_vectors.py --id "EFTA00039689.pdf-chunk-82" --meta-only
"""

import os
import sys
import json
import argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v.strip('"').replace("\\n", "").strip()
    return env


def fetch_by_ids(index, ids, meta_only=False):
    """Fetch vectors by their IDs and display stored text."""
    result = index.fetch(ids=ids)
    found = 0
    for vec_id in ids:
        vec = result.vectors.get(vec_id)
        if not vec:
            print(f"\n{'='*60}")
            print(f"NOT FOUND: {vec_id}")
            print(f"{'='*60}")
            continue

        found += 1
        meta = vec.metadata or {}
        print(f"\n{'='*60}")
        print(f"ID: {vec_id}")
        print(f"{'='*60}")
        print(f"  Filename:    {meta.get('filename', 'N/A')}")
        print(f"  Chunk Index: {meta.get('chunk_index', 'N/A')}")
        print(f"  Page:        {meta.get('page', 'NOT STORED')}")
        print(f"  GCS Path:    {meta.get('gcs_path', 'N/A')}")
        print(f"  Doc Type:    {meta.get('doc_type', 'N/A')}")
        if meta.get('people'):
            print(f"  People:      {', '.join(meta['people'][:10])}")
        if meta.get('organizations'):
            print(f"  Orgs:        {', '.join(meta['organizations'][:10])}")
        if meta.get('dates'):
            print(f"  Dates:       {', '.join(meta['dates'][:5])}")

        if not meta_only:
            text = meta.get('text', '')
            print(f"  Text Length: {len(text)} chars")
            print(f"\n  --- TEXT CONTENT ---")
            print(f"  {text}")
            print(f"  --- END ---")

    return found


def search_file_chunks(index, filename, keyword, max_chunks=200):
    """Search through all chunks of a file for a keyword."""
    print(f"\nSearching '{filename}' for: \"{keyword}\"")
    print(f"{'='*60}")

    matches = 0
    for i in range(max_chunks):
        vec_id = f"{filename}-chunk-{i}"
        try:
            result = index.fetch(ids=[vec_id])
            vec = result.vectors.get(vec_id)
            if not vec:
                break  # No more chunks

            text = (vec.metadata or {}).get('text', '')
            if keyword.lower() in text.lower():
                matches += 1
                page = (vec.metadata or {}).get('page', 'N/A')
                chunk_idx = (vec.metadata or {}).get('chunk_index', i)
                print(f"\n  MATCH in chunk {chunk_idx} (page: {page}):")

                # Show context around the keyword
                lower_text = text.lower()
                pos = lower_text.find(keyword.lower())
                start = max(0, pos - 150)
                end = min(len(text), pos + len(keyword) + 150)
                snippet = text[start:end]
                if start > 0:
                    snippet = "..." + snippet
                if end < len(text):
                    snippet = snippet + "..."
                print(f"  {snippet}")
        except Exception as e:
            print(f"  Error fetching chunk {i}: {e}")
            break

    print(f"\n  Found {matches} chunks containing \"{keyword}\" (searched {i+1} chunks)")
    return matches


def list_file_chunks(index, filename, max_chunks=300):
    """List all chunks for a file with a short preview."""
    print(f"\nAll chunks for: {filename}")
    print(f"{'='*60}")

    chunk_count = 0
    for i in range(max_chunks):
        vec_id = f"{filename}-chunk-{i}"
        try:
            result = index.fetch(ids=[vec_id])
            vec = result.vectors.get(vec_id)
            if not vec:
                break

            meta = vec.metadata or {}
            text = meta.get('text', '')
            page = meta.get('page', '-')
            preview = text[:100].replace('\n', ' ')
            print(f"  [{i:3d}] (page {page}) {preview}...")
            chunk_count += 1
        except Exception as e:
            print(f"  Error at chunk {i}: {e}")
            break

    print(f"\n  Total: {chunk_count} chunks")
    return chunk_count


def main():
    parser = argparse.ArgumentParser(description="Verify Pinecone vector contents")
    parser.add_argument("--id", nargs="+", help="Vector ID(s) to fetch")
    parser.add_argument("--file", type=str, help="Filename to search/list chunks for")
    parser.add_argument("--search", type=str, help="Keyword to search for within a file's chunks")
    parser.add_argument("--list", action="store_true", help="List all chunks for a file")
    parser.add_argument("--meta-only", action="store_true", help="Show metadata only, skip text content")
    args = parser.parse_args()

    if not args.id and not args.file:
        parser.print_help()
        print("\nError: Provide --id or --file")
        sys.exit(1)

    if args.file and not args.search and not args.list:
        parser.print_help()
        print("\nError: With --file, also provide --search <keyword> or --list")
        sys.exit(1)

    # Initialize Pinecone
    env = load_env()
    from pinecone import Pinecone
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    index = pc.Index("localwebb")

    if args.id:
        fetch_by_ids(index, args.id, meta_only=args.meta_only)
    elif args.file and args.search:
        search_file_chunks(index, args.file, args.search)
    elif args.file and args.list:
        list_file_chunks(index, args.file)


if __name__ == "__main__":
    main()

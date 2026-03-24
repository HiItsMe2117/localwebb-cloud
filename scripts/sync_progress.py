"""
Sync reindex_progress.json with what's actually in Supabase document_chunks.

Queries Supabase for all distinct filenames that have been vectorized,
then builds a progress file so reindex.py --resume only processes truly missing files.
"""

import os
import sys
import json
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "reindex_progress.json"


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

    # Set up GCP credentials
    gcp_json = env.get("GCP_SERVICE_ACCOUNT_JSON", "")
    if gcp_json:
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write(gcp_json)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

    from supabase import create_client
    sb = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])

    # Get all distinct filenames using the DB function (uses index, much faster)
    print("Querying Supabase for vectorized filenames via get_unique_filenames()...")
    res = sb.rpc("get_unique_filenames").limit(500000).execute()
    all_filenames = {row["filename"] for row in res.data if row.get("filename")}
    print(f"Total unique filenames in Supabase: {len(all_filenames)}")

    # Use the existing vectors_upserted from the old progress as a baseline
    # (exact count query times out on large tables)
    total_vectors = 0

    # Load existing progress to preserve failed list
    old_progress = {"completed": [], "failed": [], "vectors_upserted": 0}
    if PROGRESS_FILE.exists():
        old_progress = json.loads(PROGRESS_FILE.read_text())

    old_failed = set(old_progress.get("failed", []))
    # Remove from failed if they're now in Supabase
    still_failed = old_failed - all_filenames

    new_progress = {
        "completed": sorted(all_filenames),
        "failed": sorted(still_failed),
        "vectors_upserted": total_vectors,
    }

    # Backup old progress
    if PROGRESS_FILE.exists():
        backup = PROGRESS_FILE.with_suffix(".json.bak")
        PROGRESS_FILE.rename(backup)
        print(f"Backed up old progress to {backup.name}")

    PROGRESS_FILE.write_text(json.dumps(new_progress, indent=2))
    print(f"\nNew progress file written:")
    print(f"  Completed: {len(new_progress['completed'])}")
    print(f"  Failed: {len(new_progress['failed'])}")
    print(f"  Vectors: {new_progress['vectors_upserted']}")

    # Also list GCS files to show what's actually missing
    from google.cloud import storage
    storage_client = storage.Client()
    bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])
    print("\nListing GCS PDFs to find unprocessed files...")
    gcs_filenames = set()
    for blob in bucket.list_blobs():
        if blob.name.lower().endswith(".pdf"):
            gcs_filenames.add(blob.name.split("/")[-1])

    missing = gcs_filenames - all_filenames - still_failed
    print(f"\nGCS files: {len(gcs_filenames)}")
    print(f"Already vectorized: {len(all_filenames)}")
    print(f"Previously failed: {len(still_failed)}")
    print(f"Truly unprocessed: {len(missing)}")

    if missing:
        print(f"\nSample unprocessed files:")
        for f in sorted(missing)[:20]:
            print(f"  {f}")


if __name__ == "__main__":
    main()

"""
Text-only re-index for LocalWebb Cloud.

Processes failed/new PDFs and inserts into Supabase document_chunks
WITHOUT generating embeddings or touching Pinecone. Since search now
runs on Supabase full-text search (tsvector), embeddings aren't needed.

Usage:
    # Re-process the 3,202 files that failed during the original reindex:
    python3 scripts/reindex_text_only.py

    # Resume from where you left off:
    python3 scripts/reindex_text_only.py --resume

    # Process only GCS files not yet in document_chunks:
    python3 scripts/reindex_text_only.py --new-only

    # Process a single file for testing:
    python3 scripts/reindex_text_only.py --test

    # Only files from specific data sets:
    python3 scripts/reindex_text_only.py --dataset 8,11
"""

import os
import sys
import json
import time
import tempfile
import argparse
from pathlib import Path
from tqdm import tqdm

# Reuse helpers from the original reindex script
from reindex import (
    load_env,
    chunk_text_with_pages,
    extract_metadata_heuristic,
    extract_text_with_gemini,
    classify_dataset,
    format_time,
    ENV_FILE,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROGRESS_FILE = SCRIPT_DIR / "reindex_text_only_progress.json"
ORIGINAL_PROGRESS_FILE = SCRIPT_DIR / "reindex_progress.json"

SUPABASE_BATCH_SIZE = 500  # rows per upsert call


def load_progress():
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {"completed": [], "failed": {}, "chunks_inserted": 0}


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def load_original_failed():
    """Read the failed file list from the original reindex run."""
    if ORIGINAL_PROGRESS_FILE.exists():
        data = json.loads(ORIGINAL_PROGRESS_FILE.read_text())
        return data.get("failed", [])
    return []


def get_indexed_filenames(supabase_client):
    """Get the set of filenames already in document_chunks."""
    filenames = set()
    offset = 0
    batch = 1000
    while True:
        resp = (
            supabase_client.table("document_chunks")
            .select("filename")
            .range(offset, offset + batch - 1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        for row in rows:
            filenames.add(row["filename"])
        if len(rows) < batch:
            break
        offset += batch
    return filenames


def insert_chunks_to_supabase(supabase_client, chunks_with_pages, filename, gcs_path):
    """Insert text chunks directly into document_chunks (no embeddings)."""
    rows = []
    for i, (chunk_text, page) in enumerate(chunks_with_pages):
        meta = extract_metadata_heuristic(chunk_text, filename)
        rows.append({
            "id": f"{filename}-chunk-{i}",
            "filename": filename,
            "page": int(page),
            "chunk_index": i,
            "text": chunk_text,
            "gcs_path": gcs_path,
            "doc_type": meta.get("doc_type", "other"),
            "people": meta.get("people", []) or [],
            "organizations": meta.get("organizations", []) or [],
            "dates": meta.get("dates", []) or [],
        })

    # Upsert in batches
    inserted = 0
    for i in range(0, len(rows), SUPABASE_BATCH_SIZE):
        batch = rows[i : i + SUPABASE_BATCH_SIZE]
        supabase_client.table("document_chunks").upsert(batch).execute()
        inserted += len(batch)

    return inserted


def main():
    parser = argparse.ArgumentParser(description="Text-only re-index (no embeddings)")
    parser.add_argument("--resume", action="store_true", help="Resume from progress file, skip completed files")
    parser.add_argument("--test", action="store_true", help="Process only 1 file as a test")
    parser.add_argument("--new-only", action="store_true", help="Process GCS files not yet in document_chunks (for newly downloaded files)")
    parser.add_argument("--dataset", type=str, help="Only process files from specific data set(s), comma-separated (e.g., 8 or 8,11)")
    parser.add_argument("--skip-ocr-fallback", action="store_true", help="Skip Gemini vision OCR for files where PyPDF fails")
    args = parser.parse_args()

    dataset_filter = None
    if args.dataset:
        dataset_filter = set(d.strip() for d in args.dataset.split(","))

    print("=" * 60)
    print("LocalWebb Cloud — Text-Only Re-Index (No Embeddings)")
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
    from google.cloud import storage
    from supabase import create_client
    from pypdf import PdfReader
    import io

    storage_client = storage.Client()
    bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])

    sb_url = env.get("SUPABASE_URL", "")
    sb_key = env.get("SUPABASE_SERVICE_KEY", "")
    if not sb_url or not sb_key:
        print("ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.prod")
        sys.exit(1)
    supabase_client = create_client(sb_url, sb_key)
    print("Connected to Supabase")

    # Gemini client (only needed for OCR fallback)
    genai_client = None
    genai_types = None
    if not args.skip_ocr_fallback:
        from google import genai
        from google.genai import types
        genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
        genai_types = types
        print("Gemini vision OCR fallback enabled")
    else:
        print("Gemini vision OCR fallback disabled (--skip-ocr-fallback)")

    # Load or reset progress
    if args.resume:
        progress = load_progress()
        print(f"Resuming: {len(progress['completed'])} already done, {len(progress['failed'])} failed")
    else:
        progress = {"completed": [], "failed": {}, "chunks_inserted": 0}

    completed_set = set(progress["completed"])

    # Determine which files to process
    if args.new_only:
        # Scan GCS for all PDFs, then exclude those already in document_chunks
        print("\nScanning GCS for all PDFs...")
        blobs = [b for b in bucket.list_blobs() if b.name.lower().endswith(".pdf")]
        print(f"Found {len(blobs)} PDFs in GCS")

        print("Checking which files are already indexed...")
        indexed = get_indexed_filenames(supabase_client)
        print(f"Already indexed: {len(indexed)} unique filenames")

        to_process = [b for b in blobs if b.name.split("/")[-1] not in indexed and b.name.split("/")[-1] not in completed_set]
        print(f"New files to process: {len(to_process)}")
    else:
        # Default: re-process files from the original reindex's failed list
        failed_filenames = load_original_failed()
        print(f"\nOriginal reindex failed list: {len(failed_filenames)} files")

        # Remove already-completed from our own progress
        failed_filenames = [f for f in failed_filenames if f not in completed_set]
        print(f"After removing our completed: {len(failed_filenames)} files remaining")

        # Map filenames to GCS blobs
        print("Listing GCS blobs...")
        all_blobs = {b.name.split("/")[-1]: b for b in bucket.list_blobs() if b.name.lower().endswith(".pdf")}
        print(f"Found {len(all_blobs)} PDFs in GCS")

        to_process = []
        missing = 0
        for fname in failed_filenames:
            if fname in all_blobs:
                to_process.append(all_blobs[fname])
            else:
                missing += 1
        if missing:
            print(f"Warning: {missing} failed files not found in GCS (possibly deleted)")

    # Filter by dataset if specified
    if dataset_filter:
        before = len(to_process)
        to_process = [b for b in to_process if classify_dataset(b.name) in dataset_filter]
        print(f"Filtered to {len(to_process)} files from data set(s): {', '.join(sorted(dataset_filter))} (was {before})")

    if args.test:
        to_process = to_process[:1]
        print("TEST MODE: processing 1 file only\n")

    print(f"\nFiles to process: {len(to_process)}")

    # Process each PDF
    processing_start = time.time()
    files_ok = 0
    files_failed = 0

    pbar = tqdm(to_process, desc="Text-only index", unit="file", dynamic_ncols=True)
    for blob in pbar:
        filename = blob.name.split("/")[-1]
        pbar.set_postfix_str(filename[:40], refresh=True)

        try:
            # Download PDF
            pdf_bytes = blob.download_as_bytes()
            size_mb = len(pdf_bytes) / (1024 * 1024)

            # Get page count and try standard text extraction
            reader = PdfReader(io.BytesIO(pdf_bytes))
            page_count = len(reader.pages)

            page_texts = []
            good_pages = 0
            for page_idx, page in enumerate(reader.pages):
                page_text = (page.extract_text() or "").strip()
                clean_words = [w for w in page_text.split() if len(w) > 2 and w.isalpha()]
                if len(clean_words) >= 10:
                    good_pages += 1
                page_texts.append((page_idx + 1, page_text))

            quality_ratio = good_pages / max(page_count, 1)
            total_standard_chars = sum(len(t) for _, t in page_texts)

            # Decide extraction method
            if quality_ratio >= 0.5 and total_standard_chars > 200:
                pass  # standard extraction is good enough
            elif args.skip_ocr_fallback or not genai_client:
                progress["failed"][filename] = "ocr_skipped"
                save_progress(progress)
                pbar.set_postfix_str(f"{filename[:30]} SKIP-OCR", refresh=True)
                continue
            else:
                page_texts = extract_text_with_gemini(genai_client, genai_types, pdf_bytes, filename, page_count)
                total_chars = sum(len(t) for _, t in page_texts)
                if total_chars == 0:
                    progress["failed"][filename] = "ocr_empty"
                    save_progress(progress)
                    pbar.set_postfix_str(f"{filename[:30]} OCR-EMPTY", refresh=True)
                    continue

            total_text = sum(len(t) for _, t in page_texts)
            if not page_texts or total_text < 50:
                progress["failed"][filename] = "no_text"
                save_progress(progress)
                pbar.set_postfix_str(f"{filename[:30]} NO-TEXT", refresh=True)
                continue

            # Chunk the text with page tracking
            chunks_with_pages = chunk_text_with_pages(page_texts)

            # Insert into Supabase (no embeddings!)
            gcs_path = f"gs://{env['GCS_BUCKET_NAME']}/{blob.name}"
            inserted = insert_chunks_to_supabase(supabase_client, chunks_with_pages, filename, gcs_path)

            progress["completed"].append(filename)
            completed_set.add(filename)
            progress["chunks_inserted"] += inserted
            # Remove from failed if previously failed in our progress
            progress["failed"].pop(filename, None)
            save_progress(progress)
            files_ok += 1
            pbar.set_postfix_str(f"{filename[:30]} OK ({inserted}ch)", refresh=True)

        except Exception as e:
            err_msg = str(e)[:200]
            progress["failed"][filename] = f"error: {err_msg}"
            save_progress(progress)
            files_failed += 1
            pbar.set_postfix_str(f"{filename[:30]} ERR", refresh=True)
            # Brief pause after errors (might be rate limiting)
            time.sleep(2)

    pbar.close()

    # Summary
    total_elapsed = time.time() - processing_start
    print(f"\n{'=' * 60}")
    print("TEXT-ONLY RE-INDEX COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Total time:       {format_time(total_elapsed)}")
    print(f"  Succeeded:        {files_ok}")
    print(f"  Failed:           {files_failed}")
    print(f"  Total completed:  {len(progress['completed'])}")
    print(f"  Total failed:     {len(progress['failed'])}")
    print(f"  Chunks inserted:  {progress['chunks_inserted']}")

    # Failure breakdown
    if progress["failed"]:
        reasons = {}
        for fname, reason in progress["failed"].items():
            key = reason.split(":")[0] if ":" in reason else reason
            reasons[key] = reasons.get(key, 0) + 1
        print(f"\n  Failure breakdown:")
        for reason, count in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"    {reason}: {count}")

    print(f"\nProgress saved to: {PROGRESS_FILE}")

    # Update pipeline status in GCS
    try:
        from generate_pipeline_status import generate_status, upload_to_gcs
        print("\nUpdating pipeline status in GCS...")
        status = generate_status()
        upload_to_gcs(status)
    except Exception as e:
        print(f"Warning: Could not update pipeline status: {e}")


if __name__ == "__main__":
    main()

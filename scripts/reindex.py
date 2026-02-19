"""
Bulk re-index script for LocalWebb Cloud.

Downloads all PDFs from GCS, extracts text using Gemini 2.5 Pro vision
(proper OCR for scanned documents), and re-indexes into Pinecone with
gemini-embedding-001 embeddings (3072-dim).

Usage:
    python3 scripts/reindex.py

    # Resume from a specific file (skips already-processed files):
    python3 scripts/reindex.py --resume

    # Process a single file for testing:
    python3 scripts/reindex.py --test

    # Process only files from specific data sets:
    python3 scripts/reindex.py --resume --dataset 9,11

    # Skip Gemini vision OCR fallback (faster, skips image-only files):
    python3 scripts/reindex.py --resume --skip-ocr-fallback
"""

import os
import sys
import json
import time
import tempfile
import argparse
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "reindex_progress.json"

CHUNK_SIZE = 1500       # chars per chunk (with overlap)
CHUNK_OVERLAP = 200     # overlap between chunks for context continuity
EMBED_BATCH_DELAY = 1.0 # seconds between embedding calls (rate limit)
VISION_DELAY = 3.0      # seconds between Gemini vision calls (rate limit)
MAX_PDF_SIZE_MB = 20    # max PDF size for single Gemini vision call
MAX_RETRIES = 3
GEMINI_TIMEOUT_MS = 120_000  # 2-minute timeout per Gemini request


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
    return {"completed": [], "failed": [], "vectors_upserted": 0}


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks (legacy, no page tracking)."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


def chunk_text_with_pages(page_texts, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split page-annotated text into overlapping chunks with page numbers.

    Args:
        page_texts: list of (page_number, text) tuples — one per PDF page.

    Returns:
        list of (chunk_text, page_number) tuples. Each chunk is tagged with
        the page it starts on.  When a chunk spans a page boundary, it gets
        the page where the majority of its content lives.
    """
    # Build a flat string and a parallel array mapping char offset -> page number
    flat = ""
    char_to_page = []
    for page_num, page_text in page_texts:
        start_offset = len(flat)
        flat += page_text + "\n\n"
        # Map every char in this page's text (plus separator) to page_num
        char_to_page.extend([page_num] * (len(flat) - start_offset))

    chunks = []
    start = 0
    while start < len(flat):
        end = min(start + chunk_size, len(flat))
        chunk = flat[start:end]
        if chunk.strip():
            # Determine the page for this chunk — use the page at the midpoint
            mid = start + (end - start) // 2
            mid = min(mid, len(char_to_page) - 1)
            page = char_to_page[mid] if char_to_page else 1
            chunks.append((chunk.strip(), page))
        # Ensure start always advances forward (avoid infinite loop at end of text)
        next_start = end - overlap
        start = max(next_start, start + 1) if end < len(flat) else len(flat)
    return chunks


def extract_text_with_gemini(client, types, pdf_bytes, filename, page_count):
    """Use Gemini 2.5 Pro vision to extract text from a PDF.

    Returns:
        list of (page_number, text) tuples for page-tracked chunking.
        For large PDFs processed in batches, each batch's text is assigned
        to the first page of that batch (best effort without per-page splits).
    """
    size_mb = len(pdf_bytes) / (1024 * 1024)

    # For large PDFs, split into page ranges
    if size_mb > MAX_PDF_SIZE_MB or page_count > 50:
        print(f"    Large PDF ({size_mb:.1f}MB, {page_count}p) — processing in sections")
        from pypdf import PdfReader, PdfWriter
        import io

        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_texts = []
        pages_per_batch = 5 if size_mb > MAX_PDF_SIZE_MB else 10

        for batch_start in range(0, len(reader.pages), pages_per_batch):
            batch_end = min(batch_start + pages_per_batch, len(reader.pages))
            writer = PdfWriter()
            for i in range(batch_start, batch_end):
                writer.add_page(reader.pages[i])

            buf = io.BytesIO()
            writer.write(buf)
            section_bytes = buf.getvalue()

            for attempt in range(MAX_RETRIES):
                try:
                    time.sleep(VISION_DELAY)
                    response = client.models.generate_content(
                        model="gemini-2.5-pro",
                        contents=[
                            types.Part.from_bytes(data=section_bytes, mime_type="application/pdf"),
                            f"Extract ALL text from pages {batch_start+1}-{batch_end} of this scanned document. "
                            "Preserve the structure faithfully. Return only the extracted text."
                        ],
                        config={"http_options": {"timeout": GEMINI_TIMEOUT_MS}}
                    )
                    batch_text = (response.text or "").strip()
                    if batch_text:
                        # Distribute text evenly across the pages in this batch
                        n_pages = batch_end - batch_start
                        chars_per_page = max(1, len(batch_text) // n_pages)
                        for p in range(n_pages):
                            p_start = p * chars_per_page
                            p_end = (p + 1) * chars_per_page if p < n_pages - 1 else len(batch_text)
                            page_texts.append((batch_start + p + 1, batch_text[p_start:p_end]))
                    print(f"    Pages {batch_start+1}-{batch_end}: {len(batch_text)} chars")
                    break
                except Exception as e:
                    if attempt < MAX_RETRIES - 1:
                        wait = (attempt + 1) * 10
                        print(f"    Retry {attempt+1} for pages {batch_start+1}-{batch_end} (waiting {wait}s): {e}")
                        time.sleep(wait)
                    else:
                        print(f"    FAILED pages {batch_start+1}-{batch_end}: {e}")

        return page_texts
    else:
        # Small enough to process in one go — assign all text to page 1
        # (best effort; Gemini doesn't provide per-page boundaries here)
        for attempt in range(MAX_RETRIES):
            try:
                time.sleep(VISION_DELAY)
                response = client.models.generate_content(
                    model="gemini-2.5-pro",
                    contents=[
                        types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
                        "Extract ALL text from this scanned document. "
                        "Preserve the structure and content faithfully. Return only the extracted text."
                    ],
                    config={"http_options": {"timeout": GEMINI_TIMEOUT_MS}}
                )
                text = (response.text or "").strip()
                if text and page_count > 1:
                    # Approximate page boundaries by splitting text evenly
                    chars_per_page = max(1, len(text) // page_count)
                    page_texts = []
                    for p in range(page_count):
                        p_start = p * chars_per_page
                        p_end = (p + 1) * chars_per_page if p < page_count - 1 else len(text)
                        page_texts.append((p + 1, text[p_start:p_end]))
                    return page_texts
                return [(1, text)]
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = (attempt + 1) * 10
                    print(f"    Retry {attempt+1} (waiting {wait}s): {e}")
                    time.sleep(wait)
                else:
                    raise
        return []


UPSERT_BATCH_SIZE = 100  # vectors per Pinecone upsert call


def extract_metadata_heuristic(text, filename):
    """Extract enriched metadata using regex heuristics (no API calls, safe for bulk)."""
    import re

    # Extract person names: capitalized multi-word sequences (heuristic)
    name_pattern = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b')
    people = list(set(name_pattern.findall(text)))[:20]

    # Extract organization-like names (Inc, LLC, Corp, Foundation, etc.)
    org_pattern = re.compile(
        r'\b([A-Z][A-Za-z&\s]+(?:Inc|LLC|Corp|Foundation|Trust|Ltd|Company|Bank|Group|Associates|Partners)\.?)\b'
    )
    orgs = list(set(org_pattern.findall(text)))[:20]

    # Extract dates in various formats
    date_patterns = [
        re.compile(r'\b(\d{4}-\d{2}-\d{2})\b'),                          # ISO
        re.compile(r'\b(\d{1,2}/\d{1,2}/\d{4})\b'),                      # MM/DD/YYYY
        re.compile(r'\b(\d{1,2}/\d{1,2}/\d{2})\b'),                      # MM/DD/YY
        re.compile(r'\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4})\b'),  # Month DD, YYYY
    ]
    dates = []
    for pat in date_patterns:
        dates.extend(pat.findall(text))
    dates = list(set(dates))[:10]

    # Classify document type based on keywords
    text_lower = text.lower()
    fname_lower = filename.lower()
    if any(kw in text_lower or kw in fname_lower for kw in ['flight', 'passenger', 'tail number', 'aircraft', 'departure']):
        doc_type = 'flight_log'
    elif any(kw in text_lower or kw in fname_lower for kw in ['deposition', 'testimony', 'sworn', 'under oath']):
        doc_type = 'deposition'
    elif any(kw in text_lower or kw in fname_lower for kw in ['transfer', 'wire', 'account', 'balance', 'transaction']):
        doc_type = 'financial_record'
    elif any(kw in text_lower or kw in fname_lower for kw in ['dear', 'sincerely', 'regards', 'letter']):
        doc_type = 'correspondence'
    elif any(kw in text_lower or kw in fname_lower for kw in ['court', 'filed', 'plaintiff', 'defendant', 'motion', 'order']):
        doc_type = 'legal_filing'
    elif any(kw in text_lower or kw in fname_lower for kw in ['report', 'summary', 'findings', 'investigation']):
        doc_type = 'report'
    else:
        doc_type = 'other'

    return {
        "people": people,
        "organizations": orgs,
        "dates": dates,
        "doc_type": doc_type,
    }


def embed_and_upsert(client, index, chunks_with_pages, filename, gcs_path):
    """Embed text chunks and batch-upsert into Pinecone with enriched metadata.

    Args:
        chunks_with_pages: list of (chunk_text, page_number) tuples.
    """
    upserted = 0
    batch = []
    for i, (chunk, page) in enumerate(chunks_with_pages):
        for attempt in range(MAX_RETRIES):
            try:
                time.sleep(EMBED_BATCH_DELAY)
                res = client.models.embed_content(
                    model="gemini-embedding-001",
                    contents=[chunk]
                )
                vec_id = f"{filename}-chunk-{i}"
                meta = {
                    "text": chunk,
                    "filename": filename,
                    "gcs_path": gcs_path,
                    "chunk_index": i,
                    "page": page,
                }
                meta.update(extract_metadata_heuristic(chunk, filename))
                batch.append((vec_id, res.embeddings[0].values, meta))
                upserted += 1
                if len(batch) >= UPSERT_BATCH_SIZE:
                    index.upsert(vectors=batch)
                    print(f"    Flushed batch of {len(batch)} vectors")
                    batch = []
                break
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = (attempt + 1) * 5
                    print(f"    Embed retry {attempt+1} chunk {i} (waiting {wait}s): {e}")
                    time.sleep(wait)
                else:
                    print(f"    FAILED to embed chunk {i}: {e}")
    if batch:
        index.upsert(vectors=batch)
        print(f"    Flushed final batch of {len(batch)} vectors")
    return upserted


def classify_dataset(filename):
    """Attempt to classify which DOJ data set a file belongs to based on its name."""
    fname = filename.lower()
    # Files from the scraper often have "dataset" in their path or name.
    # Check longer numbers first (12, 11, 10) to avoid "dataset-1" matching "dataset-11".
    for i in [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]:
        for pattern in [f"dataset{i}", f"data-set-{i}", f"dataset-{i}", f"data_set_{i}", f"dataset {i}", f"dataset%20{i}"]:
            idx = fname.find(pattern)
            if idx >= 0:
                # Ensure the match isn't a prefix of a longer number
                end_pos = idx + len(pattern)
                if end_pos >= len(fname) or not fname[end_pos].isdigit():
                    return str(i)
    # Files in the uploads/ folder are from Data Set 9
    if fname.startswith("uploads/"):
        return "9"
    return "unknown"


def format_time(seconds):
    """Format seconds into a human-readable string."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    elif seconds < 3600:
        return f"{seconds // 60:.0f}m {seconds % 60:.0f}s"
    else:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        return f"{h:.0f}h {m:.0f}m"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="Resume from progress file, skip completed files")
    parser.add_argument("--test", action="store_true", help="Process only 1 file as a test")
    parser.add_argument("--no-clear", action="store_true", help="Don't clear existing vectors first")
    parser.add_argument("--dataset", type=str, help="Only process files from specific data set(s), comma-separated (e.g., 9 or 9,11)")
    parser.add_argument("--skip-ocr-fallback", action="store_true", help="Skip Gemini vision OCR for files where PyPDF fails (faster)")
    args = parser.parse_args()

    dataset_filter = None
    if args.dataset:
        dataset_filter = set(d.strip() for d in args.dataset.split(","))

    print("=" * 60)
    print("LocalWebb Cloud — Bulk Re-Index")
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
    from google.cloud import storage
    from pinecone import Pinecone
    from pypdf import PdfReader
    import io

    genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    pinecone_index = pc.Index("localwebb")
    storage_client = storage.Client()
    bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])

    # List all PDFs
    blobs = [b for b in bucket.list_blobs() if b.name.lower().endswith(".pdf")]
    print(f"\nFound {len(blobs)} PDFs in GCS bucket '{env['GCS_BUCKET_NAME']}'")

    # Filter by dataset if specified
    if dataset_filter:
        filtered = []
        for b in blobs:
            ds = classify_dataset(b.name)
            if ds in dataset_filter:
                filtered.append(b)
        print(f"Filtered to {len(filtered)} PDFs from data set(s): {', '.join(sorted(dataset_filter))}")
        blobs = filtered

    if args.test:
        blobs = blobs[:1]
        print("TEST MODE: processing 1 file only\n")

    # Load or reset progress
    if args.resume:
        progress = load_progress()
        print(f"Resuming: {len(progress['completed'])} already done, {len(progress['failed'])} failed")
    else:
        progress = {"completed": [], "failed": [], "vectors_upserted": 0}

    # Clear old vectors (unless resuming or --no-clear)
    if not args.resume and not args.no_clear:
        print("\nClearing old vectors from Pinecone...")
        try:
            pinecone_index.delete(delete_all=True)
            print("Old vectors cleared.")
            time.sleep(2)
        except Exception as e:
            print(f"Warning: Could not clear vectors: {e}")

    # Process each PDF
    total = len(blobs)
    processing_start = time.time()
    files_processed_this_run = 0
    per_dataset_stats = {}  # dataset -> {"completed": 0, "failed": 0, "vectors": 0}

    for idx, blob in enumerate(blobs):
        filename = blob.name.split("/")[-1]

        if filename in progress["completed"]:
            print(f"\n[{idx+1}/{total}] SKIP (already done): {filename}")
            continue

        # Time estimate
        eta_str = ""
        if files_processed_this_run > 0:
            elapsed = time.time() - processing_start
            avg_per_file = elapsed / files_processed_this_run
            remaining_count = sum(1 for b in blobs[idx:] if b.name.split("/")[-1] not in progress["completed"])
            eta = avg_per_file * remaining_count
            eta_str = f" | ETA: {format_time(eta)}"

        print(f"\n{'='*60}")
        print(f"[{idx+1}/{total}] Processing: {filename} ({blob.size/(1024*1024):.1f} MB){eta_str}")
        print(f"{'='*60}")

        try:
            # Download PDF
            print("  Downloading from GCS...")
            pdf_bytes = blob.download_as_bytes()

            # Get page count
            reader = PdfReader(io.BytesIO(pdf_bytes))
            page_count = len(reader.pages)
            print(f"  Pages: {page_count}")

            # First try standard text extraction (with page tracking)
            print("  Trying standard text extraction...")
            page_texts = []  # list of (page_number, text)
            good_pages = 0
            for page_idx, page in enumerate(reader.pages):
                page_text = (page.extract_text() or "").strip()
                clean_words = [w for w in page_text.split() if len(w) > 2 and w.isalpha()]
                if len(clean_words) >= 10:
                    good_pages += 1
                page_texts.append((page_idx + 1, page_text))

            quality_ratio = good_pages / max(page_count, 1)
            total_standard_chars = sum(len(t) for _, t in page_texts)
            print(f"  Standard OCR: {good_pages}/{page_count} pages readable ({quality_ratio:.0%})")

            # Use standard text if quality is good enough, otherwise use Gemini vision
            if quality_ratio >= 0.5 and total_standard_chars > 200:
                print(f"  Using standard extraction ({total_standard_chars} chars)")
            elif args.skip_ocr_fallback:
                print(f"  Standard OCR insufficient, skipping (--skip-ocr-fallback)")
                progress["failed"].append(filename)
                save_progress(progress)
                continue
            else:
                print(f"  Using Gemini vision OCR...")
                page_texts = extract_text_with_gemini(genai_client, types, pdf_bytes, filename, page_count)
                total_chars = sum(len(t) for _, t in page_texts)
                print(f"  Gemini extracted {total_chars} chars across {len(page_texts)} page segments")

            total_text = sum(len(t) for _, t in page_texts)
            if not page_texts or total_text < 50:
                print(f"  WARNING: No meaningful text extracted, skipping")
                progress["failed"].append(filename)
                save_progress(progress)
                continue

            # Chunk the text with page tracking
            chunks_with_pages = chunk_text_with_pages(page_texts)
            print(f"  Split into {len(chunks_with_pages)} chunks (with page numbers)")

            # Embed and upsert
            gcs_path = f"gs://{env['GCS_BUCKET_NAME']}/{blob.name}"
            print(f"  Embedding and upserting...")
            upserted = embed_and_upsert(genai_client, pinecone_index, chunks_with_pages, filename, gcs_path)
            print(f"  Upserted {upserted} vectors")

            progress["completed"].append(filename)
            progress["vectors_upserted"] += upserted
            save_progress(progress)
            files_processed_this_run += 1

            # Track per-dataset stats
            ds = classify_dataset(filename)
            if ds not in per_dataset_stats:
                per_dataset_stats[ds] = {"completed": 0, "failed": 0, "vectors": 0}
            per_dataset_stats[ds]["completed"] += 1
            per_dataset_stats[ds]["vectors"] += upserted

        except Exception as e:
            print(f"  ERROR: {e}")
            progress["failed"].append(filename)
            save_progress(progress)
            files_processed_this_run += 1

            ds = classify_dataset(filename)
            if ds not in per_dataset_stats:
                per_dataset_stats[ds] = {"completed": 0, "failed": 0, "vectors": 0}
            per_dataset_stats[ds]["failed"] += 1

            # Wait a bit after errors (might be rate limiting)
            time.sleep(10)

    # Summary
    total_elapsed = time.time() - processing_start
    print(f"\n{'='*60}")
    print("RE-INDEX COMPLETE")
    print(f"{'='*60}")
    print(f"  Total time:  {format_time(total_elapsed)}")
    print(f"  Completed:   {len(progress['completed'])}/{total}")
    print(f"  Failed:      {len(progress['failed'])}")
    print(f"  Vectors:     {progress['vectors_upserted']}")
    print(f"  This run:    {files_processed_this_run} files processed")

    if per_dataset_stats:
        print(f"\n  Per-dataset stats (this run):")
        for ds_key in sorted(per_dataset_stats.keys()):
            ds = per_dataset_stats[ds_key]
            label = f"Data Set {ds_key}" if ds_key != "unknown" else "Unknown"
            print(f"    {label}: {ds['completed']} completed, {ds['failed']} failed, {ds['vectors']} vectors")

    if progress["failed"]:
        print(f"\n  Failed files:")
        for f in progress["failed"][-20:]:
            print(f"    - {f}")
        if len(progress["failed"]) > 20:
            print(f"    ... and {len(progress['failed']) - 20} more")
    print(f"\nProgress saved to: {PROGRESS_FILE}")


if __name__ == "__main__":
    main()

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
    """Split text into overlapping chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


def extract_text_with_gemini(client, types, pdf_bytes, filename, page_count):
    """Use Gemini 2.5 Pro vision to extract text from a PDF."""
    size_mb = len(pdf_bytes) / (1024 * 1024)

    # For large PDFs, split into page ranges
    if size_mb > MAX_PDF_SIZE_MB or page_count > 50:
        print(f"    Large PDF ({size_mb:.1f}MB, {page_count}p) — processing in sections")
        from pypdf import PdfReader, PdfWriter
        import io

        reader = PdfReader(io.BytesIO(pdf_bytes))
        all_text = []
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
                    if response.text:
                        all_text.append(response.text.strip())
                    print(f"    Pages {batch_start+1}-{batch_end}: {len(response.text or '')} chars")
                    break
                except Exception as e:
                    if attempt < MAX_RETRIES - 1:
                        wait = (attempt + 1) * 10
                        print(f"    Retry {attempt+1} for pages {batch_start+1}-{batch_end} (waiting {wait}s): {e}")
                        time.sleep(wait)
                    else:
                        print(f"    FAILED pages {batch_start+1}-{batch_end}: {e}")

        return "\n\n".join(all_text)
    else:
        # Small enough to process in one go
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
                return (response.text or "").strip()
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = (attempt + 1) * 10
                    print(f"    Retry {attempt+1} (waiting {wait}s): {e}")
                    time.sleep(wait)
                else:
                    raise
        return ""


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


def embed_and_upsert(client, index, chunks, filename, gcs_path):
    """Embed text chunks and batch-upsert into Pinecone with enriched metadata."""
    upserted = 0
    batch = []
    for i, chunk in enumerate(chunks):
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="Resume from progress file, skip completed files")
    parser.add_argument("--test", action="store_true", help="Process only 1 file as a test")
    parser.add_argument("--no-clear", action="store_true", help="Don't clear existing vectors first")
    args = parser.parse_args()

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
    for idx, blob in enumerate(blobs):
        filename = blob.name.split("/")[-1]

        if filename in progress["completed"]:
            print(f"\n[{idx+1}/{total}] SKIP (already done): {filename}")
            continue

        print(f"\n{'='*60}")
        print(f"[{idx+1}/{total}] Processing: {filename} ({blob.size/(1024*1024):.1f} MB)")
        print(f"{'='*60}")

        try:
            # Download PDF
            print("  Downloading from GCS...")
            pdf_bytes = blob.download_as_bytes()

            # Get page count
            reader = PdfReader(io.BytesIO(pdf_bytes))
            page_count = len(reader.pages)
            print(f"  Pages: {page_count}")

            # First try standard text extraction
            print("  Trying standard text extraction...")
            standard_text = ""
            good_pages = 0
            for page in reader.pages:
                page_text = (page.extract_text() or "").strip()
                clean_words = [w for w in page_text.split() if len(w) > 2 and w.isalpha()]
                if len(clean_words) >= 10:
                    good_pages += 1
                    standard_text += page_text + "\n\n"

            quality_ratio = good_pages / max(page_count, 1)
            print(f"  Standard OCR: {good_pages}/{page_count} pages readable ({quality_ratio:.0%})")

            # Use standard text if quality is good enough, otherwise use Gemini vision
            if quality_ratio >= 0.5 and len(standard_text) > 200:
                text = standard_text
                print(f"  Using standard extraction ({len(text)} chars)")
            else:
                print(f"  Using Gemini vision OCR...")
                text = extract_text_with_gemini(genai_client, types, pdf_bytes, filename, page_count)
                print(f"  Gemini extracted {len(text)} chars")

            if not text or len(text.strip()) < 50:
                print(f"  WARNING: No meaningful text extracted, skipping")
                progress["failed"].append(filename)
                save_progress(progress)
                continue

            # Chunk the text
            chunks = chunk_text(text)
            print(f"  Split into {len(chunks)} chunks")

            # Embed and upsert
            gcs_path = f"gs://{env['GCS_BUCKET_NAME']}/{blob.name}"
            print(f"  Embedding and upserting...")
            upserted = embed_and_upsert(genai_client, pinecone_index, chunks, filename, gcs_path)
            print(f"  Upserted {upserted} vectors")

            progress["completed"].append(filename)
            progress["vectors_upserted"] += upserted
            save_progress(progress)

        except Exception as e:
            print(f"  ERROR: {e}")
            progress["failed"].append(filename)
            save_progress(progress)
            # Wait a bit after errors (might be rate limiting)
            time.sleep(10)

    # Summary
    print(f"\n{'='*60}")
    print("RE-INDEX COMPLETE")
    print(f"{'='*60}")
    print(f"  Completed: {len(progress['completed'])}/{total}")
    print(f"  Failed:    {len(progress['failed'])}")
    print(f"  Vectors:   {progress['vectors_upserted']}")
    if progress["failed"]:
        print(f"\n  Failed files:")
        for f in progress["failed"]:
            print(f"    - {f}")
    print(f"\nProgress saved to: {PROGRESS_FILE}")


if __name__ == "__main__":
    main()

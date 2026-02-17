#!/usr/bin/env python3
"""
Epstein Files Download & Ingest Pipeline
=========================================
Downloads publicly released DOJ Epstein case files from Archive.org and
ingests them into LocalWebb's ChromaDB vector store for semantic querying.

Usage:
    python download_and_ingest.py --test 10       # Test: 10 random files from Dataset 4
    python download_and_ingest.py                  # Full run: all datasets in order
    python download_and_ingest.py --dataset 4      # Full run: single dataset
    python download_and_ingest.py --resume         # Resume an interrupted run
"""

import os
import sys
import json
import time
import signal
import hashlib
import random
import base64
import logging
import zipfile
import argparse
from pathlib import Path
from datetime import datetime

import requests
import fitz  # PyMuPDF
from tqdm import tqdm
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader, StorageContext
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.ollama import OllamaEmbedding
import chromadb

from dataset_registry import DATASETS, get_dataset, get_processing_queue

# ── Configuration ──────────────────────────────────────────────────────────────

CHROMA_DIR = "./chroma_db"
DOWNLOAD_DIR = "./data/downloads"
LOG_DIR = "./logs"
STATE_FILE = "./pipeline_state.json"

MAX_VISION_PAGES = 5
VISION_DPI = 150
OLLAMA_URL = "http://localhost:11434/api/generate"
VISION_MODEL = "llava"

DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB chunks
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds, doubles each retry

# ── Globals ────────────────────────────────────────────────────────────────────

shutdown_requested = False


def handle_signal(signum, frame):
    global shutdown_requested
    if shutdown_requested:
        logging.warning("Force quit requested. Exiting immediately.")
        sys.exit(1)
    shutdown_requested = True
    logging.info("Shutdown requested. Finishing current file...")


signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

# ── Logging ────────────────────────────────────────────────────────────────────


def setup_logging():
    os.makedirs(LOG_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(LOG_DIR, f"pipeline_{timestamp}.log")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(sys.stdout),
        ],
    )
    logging.info(f"Log file: {log_file}")


# ── State Management ──────────────────────────────────────────────────────────


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"completed_files": {}, "datasets_done": [], "started_at": None}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def mark_file_done(state, dataset_id, filename):
    key = f"ds{dataset_id}"
    if key not in state["completed_files"]:
        state["completed_files"][key] = []
    state["completed_files"][key].append(filename)
    save_state(state)


def is_file_done(state, dataset_id, filename):
    key = f"ds{dataset_id}"
    return filename in state.get("completed_files", {}).get(key, [])


# ── Chroma Setup (matches main.py & auto_ingest.py) ──────────────────────────


def init_chroma():
    os.makedirs(CHROMA_DIR, exist_ok=True)
    db = chromadb.PersistentClient(path=CHROMA_DIR)
    chroma_collection = db.get_or_create_collection("research_notes")
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    storage_context = StorageContext.from_defaults(vector_store=vector_store)
    embed_model = OllamaEmbedding(model_name="nomic-embed-text")
    return storage_context, embed_model


# ── Download ──────────────────────────────────────────────────────────────────


def download_file(sources, dest_path, expected_sha256=None):
    """Download from tiered sources with resume support and retry."""
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    for source_idx, url in enumerate(sources):
        logging.info(f"Trying source {source_idx + 1}/{len(sources)}: {url}")

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                # Support resume via Range header
                existing_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
                headers = {}
                if existing_size > 0:
                    headers["Range"] = f"bytes={existing_size}-"
                    logging.info(f"Resuming from {existing_size / 1e6:.1f} MB")

                resp = requests.get(url, headers=headers, stream=True, timeout=30)

                if resp.status_code == 416:
                    # Range not satisfiable — file already complete
                    logging.info("File already fully downloaded.")
                    if _verify_hash(dest_path, expected_sha256):
                        return True
                    # Hash mismatch — re-download from scratch
                    os.remove(dest_path)
                    existing_size = 0
                    continue

                if resp.status_code not in (200, 206):
                    logging.warning(f"HTTP {resp.status_code} from {url}")
                    break  # Try next source

                total_size = int(resp.headers.get("content-length", 0)) + existing_size
                mode = "ab" if resp.status_code == 206 else "wb"

                with open(dest_path, mode) as f:
                    with tqdm(
                        total=total_size,
                        initial=existing_size,
                        unit="B",
                        unit_scale=True,
                        desc="Downloading",
                    ) as pbar:
                        for chunk in resp.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                            if shutdown_requested:
                                logging.info("Download paused for shutdown.")
                                save_state(load_state())
                                return False
                            f.write(chunk)
                            pbar.update(len(chunk))

                if _verify_hash(dest_path, expected_sha256):
                    logging.info("Download complete and verified.")
                    return True
                else:
                    logging.warning("Hash mismatch — retrying.")
                    os.remove(dest_path)
                    existing_size = 0

            except requests.RequestException as e:
                wait = RETRY_BACKOFF * (2 ** (attempt - 1))
                logging.warning(f"Attempt {attempt}/{MAX_RETRIES} failed: {e}")
                if attempt < MAX_RETRIES:
                    logging.info(f"Retrying in {wait}s...")
                    time.sleep(wait)

        logging.warning(f"Source {source_idx + 1} exhausted.")

    logging.error("All download sources failed.")
    return False


def _verify_hash(file_path, expected_sha256):
    """Verify SHA256 hash. Returns True if hash matches or no hash provided."""
    if not expected_sha256:
        logging.info("No hash provided — skipping verification.")
        return True

    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    actual = sha256.hexdigest()
    if actual == expected_sha256:
        return True
    logging.warning(f"Hash mismatch: expected {expected_sha256[:16]}... got {actual[:16]}...")
    return False


# ── Extract ───────────────────────────────────────────────────────────────────


def extract_pdfs(zip_path, extract_dir):
    """Extract only PDF files from ZIP, flattening nested directories."""
    os.makedirs(extract_dir, exist_ok=True)
    extracted = []

    with zipfile.ZipFile(zip_path, "r") as zf:
        pdf_entries = [e for e in zf.namelist() if e.lower().endswith(".pdf") and not e.startswith("__MACOSX")]
        logging.info(f"Found {len(pdf_entries)} PDFs in archive.")

        for entry in pdf_entries:
            # Flatten: use just the filename, not nested path
            basename = os.path.basename(entry)
            if not basename:
                continue

            dest = os.path.join(extract_dir, basename)
            # Handle name collisions
            if os.path.exists(dest):
                name, ext = os.path.splitext(basename)
                dest = os.path.join(extract_dir, f"{name}_{hash(entry) % 10000}{ext}")

            with zf.open(entry) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            extracted.append(dest)

    logging.info(f"Extracted {len(extracted)} PDFs to {extract_dir}")
    return extracted


# ── Vision Analysis ───────────────────────────────────────────────────────────


def analyze_scanned_pdf(file_path, dataset_id):
    """
    Detect if PDF is scanned (no extractable text). If so, render up to
    MAX_VISION_PAGES at VISION_DPI and send each to LLaVA for description.
    Returns path to description file, or None if PDF has text.
    """
    filename = os.path.basename(file_path)
    try:
        doc = fitz.open(file_path)
    except Exception as e:
        logging.warning(f"Could not open {filename}: {e}")
        return None

    # Check if any page has extractable text
    has_text = any(page.get_text().strip() for page in doc)
    if has_text:
        doc.close()
        return None

    if len(doc) == 0:
        doc.close()
        return None

    logging.info(f"Scanned PDF detected: {filename} ({len(doc)} pages)")

    pages_to_analyze = min(len(doc), MAX_VISION_PAGES)
    descriptions = []

    for page_num in range(pages_to_analyze):
        if shutdown_requested:
            break

        page = doc[page_num]
        # Render at higher DPI for better LLaVA accuracy
        mat = fitz.Matrix(VISION_DPI / 72, VISION_DPI / 72)
        pix = page.get_pixmap(matrix=mat)
        img_data = pix.tobytes("png")

        prompt = (
            "This is a scanned legal/government document from the Epstein case files "
            f"(page {page_num + 1} of {len(doc)}). "
            "Describe the document type and extract all readable text, names, dates, "
            "and key details. Be thorough and precise."
        )

        try:
            resp = requests.post(
                OLLAMA_URL,
                json={
                    "model": VISION_MODEL,
                    "prompt": prompt,
                    "images": [base64.b64encode(img_data).decode("utf-8")],
                    "stream": False,
                },
                timeout=120,
            )
            description = resp.json().get("response", "")
            descriptions.append(
                f"=== PAGE {page_num + 1} ===\n{description}"
            )
            logging.info(f"  Page {page_num + 1}/{pages_to_analyze} analyzed ({len(description)} chars)")
        except Exception as e:
            logging.warning(f"  Vision failed on page {page_num + 1}: {e}")

    doc.close()

    if not descriptions:
        return None

    # Write structured description file
    desc_path = file_path + ".desc.txt"
    header = (
        f"VISUAL_ANALYSIS: {filename}\n"
        f"SOURCE: DOJ Epstein Files — Dataset {dataset_id}\n"
        f"PAGES_ANALYZED: {pages_to_analyze}\n"
        f"TIMESTAMP: {datetime.now().isoformat()}\n"
        f"{'=' * 60}\n\n"
    )
    with open(desc_path, "w") as f:
        f.write(header + "\n\n".join(descriptions))

    return desc_path


# ── Ingest ────────────────────────────────────────────────────────────────────


def ingest_file(file_path, desc_path, storage_context, embed_model):
    """Vectorize a PDF (and its description) into Chroma."""
    input_files = [file_path]
    if desc_path and os.path.exists(desc_path):
        input_files.append(desc_path)

    documents = SimpleDirectoryReader(input_files=input_files).load_data()
    VectorStoreIndex.from_documents(
        documents,
        storage_context=storage_context,
        embed_model=embed_model,
    )


# ── Pipeline ──────────────────────────────────────────────────────────────────


def process_dataset(dataset_id, state, storage_context, embed_model, test_count=None):
    """Full pipeline for one dataset: download → extract → ingest → cleanup."""
    ds = get_dataset(dataset_id)
    if not ds:
        logging.error(f"Unknown dataset: {dataset_id}")
        return False
    if ds["skip"]:
        logging.info(f"Skipping {ds['name']} (marked skip — too large)")
        return True

    logging.info(f"\n{'=' * 60}")
    logging.info(f"PROCESSING: {ds['name']} (~{ds['size_gb']} GB)")
    logging.info(f"{'=' * 60}")

    zip_filename = ds["filename"]
    zip_path = os.path.join(DOWNLOAD_DIR, zip_filename)
    extract_dir = os.path.join(DOWNLOAD_DIR, f"dataset_{dataset_id}")

    # ── Step 1: Download ──
    if not os.path.exists(zip_path):
        logging.info("Step 1/4: Downloading...")
        if not download_file(ds["sources"], zip_path, ds.get("sha256")):
            return False
    else:
        logging.info("Step 1/4: ZIP already downloaded, skipping.")

    if shutdown_requested:
        return False

    # ── Step 2: Extract ──
    if not os.path.exists(extract_dir) or not os.listdir(extract_dir):
        logging.info("Step 2/4: Extracting PDFs...")
        pdf_paths = extract_pdfs(zip_path, extract_dir)
    else:
        pdf_paths = [
            os.path.join(extract_dir, f)
            for f in os.listdir(extract_dir)
            if f.lower().endswith(".pdf")
        ]
        logging.info(f"Step 2/4: Already extracted, found {len(pdf_paths)} PDFs.")

    if not pdf_paths:
        logging.warning("No PDFs found. Skipping dataset.")
        return True

    # Delete ZIP after extraction to save disk space
    if os.path.exists(zip_path):
        os.remove(zip_path)
        logging.info(f"Deleted ZIP to free ~{ds['size_gb']} GB")

    if shutdown_requested:
        return False

    # ── Step 3: Select files (test mode) ──
    if test_count is not None:
        random.shuffle(pdf_paths)
        pdf_paths = pdf_paths[:test_count]
        logging.info(f"TEST MODE: Selected {len(pdf_paths)} random PDFs")

    # Filter out already-processed files (resume support)
    remaining = [p for p in pdf_paths if not is_file_done(state, dataset_id, os.path.basename(p))]
    already_done = len(pdf_paths) - len(remaining)
    if already_done > 0:
        logging.info(f"Skipping {already_done} already-processed files (resume)")

    # ── Step 4: Ingest ──
    logging.info(f"Step 3/4: Ingesting {len(remaining)} PDFs...")
    errors = 0

    pbar = tqdm(total=len(remaining), desc="Ingesting", unit="file")
    for file_path in remaining:
        if shutdown_requested:
            pbar.close()
            logging.info(f"Shutdown: {pbar.n}/{len(remaining)} files processed.")
            return False

        filename = os.path.basename(file_path)
        pbar.set_postfix_str(filename[:30])

        try:
            # Vision analysis for scanned PDFs
            desc_path = analyze_scanned_pdf(file_path, dataset_id)

            # Vectorize into Chroma
            ingest_file(file_path, desc_path, storage_context, embed_model)

            # Mark done
            mark_file_done(state, dataset_id, filename)

            # Clean up description file
            if desc_path and os.path.exists(desc_path):
                os.remove(desc_path)

        except Exception as e:
            logging.error(f"Failed on {filename}: {e}")
            errors += 1

        pbar.update(1)

    pbar.close()

    # ── Step 5: Cleanup extracted files ──
    logging.info("Step 4/4: Cleaning up extracted files...")
    try:
        import shutil
        shutil.rmtree(extract_dir, ignore_errors=True)
    except Exception as e:
        logging.warning(f"Cleanup failed: {e}")

    if errors == 0 and dataset_id not in state["datasets_done"]:
        state["datasets_done"].append(dataset_id)
        save_state(state)

    logging.info(f"Dataset {dataset_id} complete. Errors: {errors}")
    return errors == 0


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Download & ingest DOJ Epstein case files into LocalWebb"
    )
    parser.add_argument(
        "--test", type=int, metavar="N",
        help="Test mode: ingest N random files from Dataset 4",
    )
    parser.add_argument(
        "--dataset", type=int, metavar="ID",
        help="Process a single dataset by ID (1-12)",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume a previously interrupted run",
    )
    args = parser.parse_args()

    setup_logging()

    logging.info("=" * 60)
    logging.info("  LOCALWEBB EPSTEIN FILES PIPELINE")
    logging.info("=" * 60)

    # Load or initialize state
    state = load_state()
    if not args.resume:
        if not state.get("started_at"):
            state["started_at"] = datetime.now().isoformat()
            save_state(state)
    else:
        logging.info(f"Resuming run started at {state.get('started_at', 'unknown')}")

    # Initialize Chroma (same DB as main.py and auto_ingest.py)
    logging.info("Initializing Chroma vector store...")
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    storage_context, embed_model = init_chroma()

    # Determine which datasets to process
    if args.test is not None:
        # Test mode: only Dataset 4 with N files
        queue = [4]
        test_count = args.test
        logging.info(f"TEST MODE: {test_count} files from Dataset 4")
    elif args.dataset is not None:
        queue = get_processing_queue(single_dataset=args.dataset)
        test_count = None
        if not queue:
            logging.error(f"Dataset {args.dataset} not found or is marked skip.")
            sys.exit(1)
    else:
        queue = get_processing_queue()
        test_count = None

    # Skip datasets already completed (resume)
    if args.resume:
        queue = [d for d in queue if d not in state.get("datasets_done", [])]
        if not queue:
            logging.info("All datasets already completed!")
            return

    logging.info(f"Processing order: {queue}")

    # Process each dataset
    for dataset_id in queue:
        if shutdown_requested:
            break

        success = process_dataset(
            dataset_id, state, storage_context, embed_model,
            test_count=test_count,
        )

        if shutdown_requested:
            logging.info("Pipeline paused. Resume with --resume flag.")
            break

        if not success:
            logging.error(f"Dataset {dataset_id} had errors. Continuing to next...")

    # Summary
    total_files = sum(len(v) for v in state.get("completed_files", {}).values())
    logging.info(f"\n{'=' * 60}")
    logging.info(f"PIPELINE SUMMARY")
    logging.info(f"  Total files ingested: {total_files}")
    logging.info(f"  Datasets completed:   {state.get('datasets_done', [])}")
    logging.info(f"  State saved to:       {STATE_FILE}")
    logging.info(f"{'=' * 60}")


if __name__ == "__main__":
    main()

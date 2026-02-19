"""
DOJ Epstein Files — Full Pipeline Orchestrator.

Ties together scraping (DOJ → GCS) and vectorization (GCS → Pinecone)
into a single command.

Usage:
    # Full pipeline for Data Set 9:
    python3 scripts/pipeline.py --datasets 9

    # Full pipeline for multiple data sets:
    python3 scripts/pipeline.py --datasets 9,11,12

    # All priority data sets:
    python3 scripts/pipeline.py --all

    # Scrape only (no vectorization):
    python3 scripts/pipeline.py --datasets 9 --scrape-only

    # Vectorize only (skip scraping, process what's already in GCS):
    python3 scripts/pipeline.py --vectorize-only
"""

import os
import sys
import json
import time
import subprocess
import argparse
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
SCRAPE_PROGRESS = SCRIPT_DIR / "scrape_progress.json"
REINDEX_PROGRESS = SCRIPT_DIR / "reindex_progress.json"

PRIORITY_ORDER = [9, 11, 12, 1, 8, 2, 4, 5, 6, 7, 3]


def run_command(cmd, description):
    """Run a subprocess command with real-time output."""
    print(f"\n{'=' * 60}")
    print(f"STAGE: {description}")
    print(f"CMD:   {' '.join(cmd)}")
    print(f"{'=' * 60}\n")

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    for line in process.stdout:
        print(line, end="")

    process.wait()
    return process.returncode


def get_scrape_stats():
    """Read scrape progress stats."""
    if SCRAPE_PROGRESS.exists():
        data = json.loads(SCRAPE_PROGRESS.read_text())
        return {
            "downloaded": len(data.get("files_downloaded", [])),
            "failed": len(data.get("files_failed", [])),
            "datasets_done": data.get("datasets_completed", []),
        }
    return {"downloaded": 0, "failed": 0, "datasets_done": []}


def get_reindex_stats():
    """Read reindex progress stats."""
    if REINDEX_PROGRESS.exists():
        data = json.loads(REINDEX_PROGRESS.read_text())
        return {
            "completed": len(data.get("completed", [])),
            "failed": len(data.get("failed", [])),
            "vectors": data.get("vectors_upserted", 0),
        }
    return {"completed": 0, "failed": 0, "vectors": 0}


def main():
    parser = argparse.ArgumentParser(description="DOJ Epstein Files — Full Pipeline")
    parser.add_argument("--datasets", type=str, help="Comma-separated data set numbers (e.g., 9,11,12)")
    parser.add_argument("--all", action="store_true", help="Process all priority data sets")
    parser.add_argument("--scrape-only", action="store_true", help="Only scrape, don't vectorize")
    parser.add_argument("--vectorize-only", action="store_true", help="Only vectorize, skip scraping")
    parser.add_argument("--skip-ocr-fallback", action="store_true", help="Skip Gemini vision OCR fallback")
    parser.add_argument("--test", action="store_true", help="Test mode (1 file per stage)")
    args = parser.parse_args()

    # Determine datasets
    if args.datasets:
        datasets = [int(d.strip()) for d in args.datasets.split(",")]
    elif args.all:
        datasets = PRIORITY_ORDER
    elif args.vectorize_only:
        datasets = []  # Not needed for vectorize-only
    else:
        parser.error("Specify --datasets N,M,..., --all, or --vectorize-only")
        return

    python = sys.executable
    start_time = time.time()

    print("=" * 60)
    print("DOJ Epstein Files — Full Pipeline")
    print("=" * 60)
    if datasets:
        print(f"Data sets: {datasets}")
    print(f"Scrape:    {'SKIP' if args.vectorize_only else 'YES'}")
    print(f"Vectorize: {'SKIP' if args.scrape_only else 'YES'}")
    print()

    # -----------------------------------------------------------------------
    # Stage 1: Scrape DOJ → GCS
    # -----------------------------------------------------------------------
    if not args.vectorize_only:
        scrape_cmd = [python, str(SCRIPT_DIR / "scrape_doj.py")]

        if len(datasets) == 1:
            scrape_cmd += ["--dataset", str(datasets[0])]
        else:
            scrape_cmd += ["--datasets", ",".join(str(d) for d in datasets)]

        scrape_cmd.append("--resume")

        if args.test:
            scrape_cmd.append("--test")

        rc = run_command(scrape_cmd, "Scrape DOJ → GCS")
        if rc != 0:
            print(f"\nWARNING: Scraper exited with code {rc}")

        stats = get_scrape_stats()
        print(f"\nScrape results: {stats['downloaded']} downloaded, {stats['failed']} failed")

    # -----------------------------------------------------------------------
    # Stage 2: Vectorize GCS → Pinecone
    # -----------------------------------------------------------------------
    if not args.scrape_only:
        reindex_cmd = [python, str(SCRIPT_DIR / "reindex.py"), "--resume", "--no-clear"]

        if datasets:
            reindex_cmd += ["--dataset", ",".join(str(d) for d in datasets)]

        if args.skip_ocr_fallback:
            reindex_cmd.append("--skip-ocr-fallback")

        if args.test:
            reindex_cmd.append("--test")

        rc = run_command(reindex_cmd, "Vectorize GCS → Pinecone")
        if rc != 0:
            print(f"\nWARNING: Reindex exited with code {rc}")

        stats = get_reindex_stats()
        print(f"\nReindex results: {stats['completed']} files, {stats['vectors']} vectors")

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    elapsed = time.time() - start_time
    hours = int(elapsed // 3600)
    minutes = int((elapsed % 3600) // 60)

    print(f"\n{'=' * 60}")
    print("PIPELINE COMPLETE")
    print(f"{'=' * 60}")
    print(f"  Total time: {hours}h {minutes}m")

    if not args.vectorize_only:
        s = get_scrape_stats()
        print(f"  Scrape — Downloaded: {s['downloaded']}, Failed: {s['failed']}")

    if not args.scrape_only:
        r = get_reindex_stats()
        print(f"  Reindex — Files: {r['completed']}, Vectors: {r['vectors']}, Failed: {r['failed']}")

    print()


if __name__ == "__main__":
    main()

"""
Generate pipeline_status.json and upload to GCS.

Reads both scrape_progress.json and reindex_progress.json, combines them into
per-dataset stats, and uploads the result to GCS so the /api/datasets endpoint
can serve it without expensive blob listing.

Usage:
    python3 scripts/generate_pipeline_status.py

This script is also called automatically at the end of scrape_doj.py and reindex.py.
"""

import os
import json
import tempfile
from pathlib import Path
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
SCRAPE_PROGRESS = SCRIPT_DIR / "scrape_progress.json"
REINDEX_PROGRESS = SCRIPT_DIR / "reindex_progress.json"

DATASET_INFO = {
    "1": {"name": "FBI Interviews & Police Reports", "description": "Palm Beach PD 2005-2008, FBI summaries"},
    "2": {"name": "Victim Statements", "description": "Police reports and victim statements"},
    "3": {"name": "Grand Jury Materials", "description": "Federal grand jury transcripts (2007)"},
    "4": {"name": "Prosecution Memos", "description": "SDNY investigative memos, co-conspirator analysis"},
    "5": {"name": "Correspondence", "description": "Internal DOJ/FBI correspondence"},
    "6": {"name": "Court Filings", "description": "Legal motions and court orders"},
    "7": {"name": "Witness Interviews", "description": "Additional witness statements"},
    "8": {"name": "Evidence Collection", "description": "Search warrant inventories, seized materials"},
    "9": {"name": "Emails & Communications", "description": "Email chains and digital correspondence"},
    "10": {"name": "Media (Excluded)", "description": "Images and videos -- excluded from text analysis"},
    "11": {"name": "Financial Records", "description": "Ledgers, flight manifests, property seizure records"},
    "12": {"name": "Late Production", "description": "~150 late-production supplemental documents"},
}


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v.strip('"').replace("\\n", "").strip()
    return env


def classify_dataset(filename):
    """Classify which dataset a file belongs to based on its name."""
    fname = filename.lower()
    for i in [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]:
        for pattern in [f"dataset{i}", f"data-set-{i}", f"dataset-{i}", f"data_set_{i}", f"dataset {i}", f"dataset%20{i}"]:
            idx = fname.find(pattern)
            if idx >= 0:
                end_pos = idx + len(pattern)
                if end_pos >= len(fname) or not fname[end_pos].isdigit():
                    return str(i)
    return "unknown"


def get_gcs_bucket():
    """Initialize and return the GCS bucket."""
    env = load_env()
    gcp_json = env.get("GCP_SERVICE_ACCOUNT_JSON", "")
    if gcp_json:
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write(gcp_json)
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

    from google.cloud import storage
    client = storage.Client()
    return client.bucket(env["GCS_BUCKET_NAME"]), env["GCS_BUCKET_NAME"]


def generate_status(bucket=None):
    """Generate the pipeline status JSON from GCS blob listing + local progress files.

    If bucket is provided, lists blobs from GCS for accurate per-dataset file counts.
    Falls back to local progress files only if bucket is None.
    """
    # Load scrape progress (for urls_discovered counts)
    scrape = {}
    if SCRAPE_PROGRESS.exists():
        scrape = json.loads(SCRAPE_PROGRESS.read_text())

    # Load reindex progress
    reindex = {}
    if REINDEX_PROGRESS.exists():
        reindex = json.loads(REINDEX_PROGRESS.read_text())

    urls_discovered = scrape.get("urls_discovered", {})
    reindex_completed = set(reindex.get("completed", []))
    reindex_failed = set(reindex.get("failed", []))
    total_vectors = reindex.get("vectors_upserted", 0)

    # --- Build per-dataset scraped counts from GCS blob listing ---
    # Maps dataset number -> list of filenames in GCS
    gcs_files_by_dataset: dict[str, list[dict]] = {k: [] for k in DATASET_INFO}

    if bucket:
        print("Listing GCS blobs under uploads/...")
        blob_count = 0
        for blob in bucket.list_blobs(prefix="uploads/"):
            if not blob.name.lower().endswith(".pdf"):
                continue
            blob_count += 1
            # Classify using the full blob path (e.g. uploads/dataset-11/file.pdf)
            ds = classify_dataset(blob.name)
            # Files in uploads/ root (no subdirectory) are dataset 9
            parts = blob.name.split("/")
            if len(parts) == 2 and ds == "unknown":
                ds = "9"
            filename = parts[-1]
            if ds in gcs_files_by_dataset:
                gcs_files_by_dataset[ds].append({
                    "filename": filename,
                    "size": blob.size or 0,
                })
            else:
                gcs_files_by_dataset.setdefault("unknown", []).append({
                    "filename": filename,
                    "size": blob.size or 0,
                })
        print(f"Found {blob_count} PDFs across GCS")

    # --- Assemble per-dataset stats ---
    datasets = {}
    for ds_num in sorted(DATASET_INFO.keys(), key=lambda x: int(x)):
        info = DATASET_INFO[ds_num]
        discovered = len(urls_discovered.get(ds_num, []))

        gcs_files = gcs_files_by_dataset.get(ds_num, [])
        gcs_filenames = {f["filename"] for f in gcs_files}
        ds_scraped = len(gcs_files)
        ds_size_mb = sum(f["size"] for f in gcs_files) / (1024 * 1024)

        # Count vectorized/failed by checking reindex progress against GCS filenames
        ds_vectorized = 0
        ds_failed_ocr = 0
        for fname in gcs_filenames:
            if fname in reindex_completed:
                ds_vectorized += 1
            elif fname in reindex_failed:
                ds_failed_ocr += 1

        datasets[ds_num] = {
            "name": info["name"],
            "description": info["description"],
            "discovered": discovered,
            "scraped": ds_scraped,
            "vectorized": ds_vectorized,
            "failed_ocr": ds_failed_ocr,
            "size_mb": round(ds_size_mb, 1),
        }

    # Compute totals
    totals = {
        "discovered": sum(d["discovered"] for d in datasets.values()),
        "scraped": sum(d["scraped"] for d in datasets.values()),
        "vectorized": sum(d["vectorized"] for d in datasets.values()),
        "failed_ocr": sum(d["failed_ocr"] for d in datasets.values()),
        "vectors": total_vectors,
        "size_mb": round(sum(d["size_mb"] for d in datasets.values()), 1),
    }

    return {
        "datasets": datasets,
        "totals": totals,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


def upload_to_gcs(status_json, bucket=None, bucket_name=None):
    """Upload pipeline_status.json to GCS."""
    if not bucket:
        bucket, bucket_name = get_gcs_bucket()
    blob = bucket.blob("pipeline_status.json")
    blob.upload_from_string(
        json.dumps(status_json, indent=2),
        content_type="application/json",
    )
    print(f"Uploaded pipeline_status.json to gs://{bucket_name}/pipeline_status.json")


def main():
    print("Generating pipeline status (with GCS blob listing)...")
    bucket, bucket_name = get_gcs_bucket()
    status = generate_status(bucket=bucket)

    # Print summary
    totals = status["totals"]
    print(f"\nTotals:")
    print(f"  Discovered: {totals['discovered']}")
    print(f"  Scraped:    {totals['scraped']}")
    print(f"  Vectorized: {totals['vectorized']}")
    print(f"  Failed OCR: {totals['failed_ocr']}")
    print(f"  Vectors:    {totals['vectors']}")

    print(f"\nPer-dataset:")
    for ds_num, ds in sorted(status["datasets"].items(), key=lambda x: int(x[0])):
        print(f"  {ds_num}. {ds['name']}: {ds['scraped']} scraped, {ds['vectorized']} vectorized, {ds['failed_ocr']} failed")

    # Save locally for debugging
    local_path = SCRIPT_DIR / "pipeline_status.json"
    local_path.write_text(json.dumps(status, indent=2))
    print(f"\nSaved locally to: {local_path}")

    # Upload to GCS
    upload_to_gcs(status, bucket=bucket, bucket_name=bucket_name)


if __name__ == "__main__":
    main()

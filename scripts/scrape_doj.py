"""
DOJ Epstein Files Scraper.

Crawls the DOJ Epstein Library (justice.gov/epstein) data set pages,
extracts all PDF links, and uploads them to Google Cloud Storage.

Usage:
    # Dry run — list URLs without downloading:
    python3 scripts/scrape_doj.py --dataset 9 --dry-run

    # Download a single data set:
    python3 scripts/scrape_doj.py --dataset 9

    # Download one file for testing:
    python3 scripts/scrape_doj.py --dataset 9 --test

    # Resume interrupted download:
    python3 scripts/scrape_doj.py --dataset 9 --resume

    # Download all priority data sets:
    python3 scripts/scrape_doj.py --all
"""

import os
import sys
import json
import time
import argparse
import tempfile
from pathlib import Path
from urllib.parse import urljoin, unquote

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"
PROGRESS_FILE = SCRIPT_DIR / "scrape_progress.json"

BASE_URL = "https://www.justice.gov"
LIBRARY_PATH = "/epstein"

# Priority order (skip Data Set 9 — done, Data Set 10 — images/videos)
PRIORITY_ORDER = [11, 12, 1, 8, 2, 4, 5, 6, 7, 3]

# Rate limiting
REQUEST_DELAY = 1.5  # seconds between DOJ page requests
DOWNLOAD_DELAY = 0.5  # seconds between PDF downloads
MAX_RETRIES = 3
REQUEST_TIMEOUT = 30

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


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
    return {
        "datasets_completed": [],
        "files_downloaded": [],
        "files_failed": [],
        "urls_discovered": {},
    }


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def get_session():
    """Create a requests session with retries, headers, and age verification cookie."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    # DOJ Epstein pages require an age verification cookie
    session.cookies.set(
        "justiceGovAgeVerified", "true",
        domain="www.justice.gov", path="/",
    )
    adapter = requests.adapters.HTTPAdapter(
        max_retries=requests.adapters.Retry(
            total=MAX_RETRIES,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def discover_dataset_urls(session, dataset_num):
    """Crawl a DOJ data set page and all its pagination to find PDF links.

    URL pattern: https://www.justice.gov/epstein/doj-disclosures/data-set-N-files
    PDF pattern: https://www.justice.gov/epstein/files/DataSet%20N/FILENAME.pdf
    Some data sets have pagination via ?page=0, ?page=1, etc.
    """
    working_url = f"{BASE_URL}/epstein/doj-disclosures/data-set-{dataset_num}-files"
    print(f"  Data set page: {working_url}")

    pdf_urls = []
    seen_urls = set()
    page = 0

    while True:
        page_url = f"{working_url}?page={page}" if page > 0 else working_url
        print(f"  Fetching page {page}: {page_url}")

        try:
            time.sleep(REQUEST_DELAY)
            resp = session.get(page_url, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 403:
                print(f"  Got 403 — DOJ may be rate-limiting. Waiting 10s...")
                time.sleep(10)
                resp = session.get(page_url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            print(f"  Error fetching page {page}: {e}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")

        # Find all PDF links on this page
        page_pdfs = []
        for link in soup.find_all("a", href=True):
            href = link["href"]
            if href.lower().endswith(".pdf"):
                full_url = urljoin(BASE_URL, href)
                if full_url not in seen_urls:
                    seen_urls.add(full_url)
                    page_pdfs.append(full_url)

        if not page_pdfs:
            if page == 0:
                print(f"  WARNING: No PDFs found on first page. Page may require age verification or be blocked.")
            else:
                print(f"  No PDFs on page {page}, stopping pagination")
            break

        pdf_urls.extend(page_pdfs)
        print(f"  Found {len(page_pdfs)} PDFs on page {page} (total: {len(pdf_urls)})")

        # Check for pagination — look for a "next" link or page=N+1 link
        has_next = False
        # Check rel="next"
        if soup.find("a", {"rel": "next"}):
            has_next = True
        else:
            # Check for pager nav with next page link
            for nav in soup.find_all(["nav", "ul", "div"]):
                nav_class = " ".join(nav.get("class", []))
                if "pager" in nav_class or "pagination" in nav_class:
                    if nav.find("a", href=lambda h: h and f"page={page+1}" in h if h else False):
                        has_next = True
                        break

        if not has_next:
            break

        page += 1

        # Safety: don't paginate forever
        if page > 10000:
            print("  Safety limit: stopped at page 10000")
            break

    return pdf_urls


def download_and_upload(session, pdf_url, bucket, progress, dataset_num):
    """Download a PDF from DOJ and upload to GCS."""
    # Extract filename from URL
    filename = unquote(pdf_url.split("/")[-1])
    gcs_path = f"uploads/dataset-{dataset_num}/{filename}"

    # Check if already downloaded
    if filename in progress["files_downloaded"]:
        return "skip"

    # Download from DOJ
    for attempt in range(MAX_RETRIES):
        try:
            time.sleep(DOWNLOAD_DELAY)
            resp = session.get(pdf_url, timeout=60)
            resp.raise_for_status()

            # Verify we got a PDF, not an HTML age-gate page
            content_type = resp.headers.get("Content-Type", "")
            if "text/html" in content_type or resp.content[:5] != b"%PDF-":
                if attempt < MAX_RETRIES - 1:
                    print(f"    Got HTML instead of PDF (age gate?), retrying...")
                    # Re-set the age verification cookie
                    session.cookies.set(
                        "justiceGovAgeVerified", "true",
                        domain="www.justice.gov", path="/",
                    )
                    time.sleep(3)
                    continue
                else:
                    print(f"    FAILED: {filename}: received HTML instead of PDF")
                    return "fail"

            content = resp.content
            size_mb = len(content) / (1024 * 1024)

            # Upload to GCS
            blob = bucket.blob(gcs_path)
            blob.upload_from_string(content, content_type="application/pdf")

            print(f"    Uploaded: {filename} ({size_mb:.1f} MB)")
            return "ok"

        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                wait = (attempt + 1) * 5
                print(f"    Retry {attempt + 1} for {filename} (waiting {wait}s): {e}")
                time.sleep(wait)
            else:
                print(f"    FAILED: {filename}: {e}")
                return "fail"

    return "fail"


def check_gcs_existing(bucket):
    """Get set of filenames already in GCS bucket."""
    existing = set()
    for blob in bucket.list_blobs(prefix="uploads/"):
        existing.add(blob.name.split("/")[-1])
    return existing


def main():
    parser = argparse.ArgumentParser(description="DOJ Epstein Files Scraper")
    parser.add_argument("--dataset", type=int, help="Single data set number to scrape (e.g., 9)")
    parser.add_argument("--datasets", type=str, help="Comma-separated data set numbers (e.g., 9,11,12)")
    parser.add_argument("--all", action="store_true", help="Scrape all priority data sets")
    parser.add_argument("--resume", action="store_true", help="Resume from progress file")
    parser.add_argument("--dry-run", action="store_true", help="List URLs only, don't download")
    parser.add_argument("--test", action="store_true", help="Download only 1 file for testing")
    args = parser.parse_args()

    # Determine which datasets to process
    if args.dataset:
        datasets = [args.dataset]
    elif args.datasets:
        datasets = [int(d.strip()) for d in args.datasets.split(",")]
    elif args.all:
        datasets = PRIORITY_ORDER
    else:
        parser.error("Specify --dataset N, --datasets N,M,..., or --all")
        return

    print("=" * 60)
    print("DOJ Epstein Files Scraper")
    print("=" * 60)
    print(f"Data sets to process: {datasets}")
    if args.dry_run:
        print("MODE: Dry run (list URLs only)")
    if args.test:
        print("MODE: Test (1 file only)")
    print()

    # Load progress
    progress = load_progress() if args.resume else {
        "datasets_completed": [],
        "files_downloaded": [],
        "files_failed": [],
        "urls_discovered": {},
    }

    session = get_session()
    bucket = None

    if not args.dry_run:
        # Load env and set up GCS
        env = load_env()
        gcp_json = env.get("GCP_SERVICE_ACCOUNT_JSON", "")
        if gcp_json:
            with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
                f.write(gcp_json)
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

        from google.cloud import storage
        storage_client = storage.Client()
        bucket = storage_client.bucket(env["GCS_BUCKET_NAME"])

        # Get existing GCS files for dedup
        print("Checking existing files in GCS...")
        existing_files = check_gcs_existing(bucket)
        print(f"Found {len(existing_files)} existing files in GCS\n")
    else:
        existing_files = set()

    total_discovered = 0
    total_downloaded = 0
    total_skipped = 0
    total_failed = 0

    for ds_num in datasets:
        if ds_num in progress.get("datasets_completed", []):
            print(f"\nData Set {ds_num}: SKIP (already completed)")
            continue

        print(f"\n{'=' * 60}")
        print(f"Data Set {ds_num}")
        print(f"{'=' * 60}")

        # Discover PDF URLs
        ds_key = str(ds_num)
        if args.resume and ds_key in progress.get("urls_discovered", {}):
            pdf_urls = progress["urls_discovered"][ds_key]
            print(f"  Using cached URL list: {len(pdf_urls)} PDFs")
        else:
            pdf_urls = discover_dataset_urls(session, ds_num)
            progress.setdefault("urls_discovered", {})[ds_key] = pdf_urls
            save_progress(progress)

        total_discovered += len(pdf_urls)
        print(f"\n  Total PDFs discovered: {len(pdf_urls)}")

        if args.dry_run:
            for i, url in enumerate(pdf_urls):
                filename = unquote(url.split("/")[-1])
                status = "EXISTS" if filename in existing_files else "NEW"
                print(f"    [{i+1}] [{status}] {filename}")
                if i >= 49 and len(pdf_urls) > 50:
                    print(f"    ... and {len(pdf_urls) - 50} more")
                    break
            continue

        # Download and upload
        ds_downloaded = 0
        ds_skipped = 0
        ds_failed = 0

        for i, url in enumerate(pdf_urls):
            filename = unquote(url.split("/")[-1])

            # Skip if already in GCS
            if filename in existing_files:
                ds_skipped += 1
                continue

            # Skip if already downloaded in this session
            if filename in progress["files_downloaded"]:
                ds_skipped += 1
                continue

            print(f"  [{i+1}/{len(pdf_urls)}] {filename}")
            result = download_and_upload(session, url, bucket, progress, ds_num)

            if result == "ok":
                progress["files_downloaded"].append(filename)
                existing_files.add(filename)
                ds_downloaded += 1
            elif result == "skip":
                ds_skipped += 1
            else:
                progress["files_failed"].append(filename)
                ds_failed += 1

            save_progress(progress)

            if args.test and ds_downloaded >= 1:
                print("\n  TEST MODE: stopping after 1 download")
                break

        total_downloaded += ds_downloaded
        total_skipped += ds_skipped
        total_failed += ds_failed

        print(f"\n  Data Set {ds_num} Summary:")
        print(f"    Downloaded: {ds_downloaded}")
        print(f"    Skipped:    {ds_skipped}")
        print(f"    Failed:     {ds_failed}")

        if not args.test and ds_failed == 0:
            progress.setdefault("datasets_completed", []).append(ds_num)
            save_progress(progress)

    # Final summary
    print(f"\n{'=' * 60}")
    print("SCRAPE COMPLETE")
    print(f"{'=' * 60}")
    print(f"  URLs discovered: {total_discovered}")
    if not args.dry_run:
        print(f"  Downloaded:      {total_downloaded}")
        print(f"  Skipped (dupes): {total_skipped}")
        print(f"  Failed:          {total_failed}")
    if progress.get("files_failed"):
        print(f"\n  Failed files:")
        for f in progress["files_failed"][-20:]:
            print(f"    - {f}")
        if len(progress["files_failed"]) > 20:
            print(f"    ... and {len(progress['files_failed']) - 20} more")
    print(f"\nProgress saved to: {PROGRESS_FILE}")


if __name__ == "__main__":
    main()

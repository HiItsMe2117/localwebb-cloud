#!/usr/bin/env python3
"""Real-time terminal progress display for the reindex pipeline.

Polls reindex_progress.json every 2 seconds and displays a live progress bar
with stats. Uses ANSI escape codes to overwrite lines in-place.

Usage:
    python3 scripts/watch_progress.py
    python3 scripts/watch_progress.py --total 3885
    python3 scripts/watch_progress.py --dataset 1,2,4,7,6
"""

import argparse
import json
import os
import signal
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REINDEX_PATH = os.path.join(SCRIPT_DIR, "reindex_progress.json")
SCRAPE_PATH = os.path.join(SCRIPT_DIR, "scrape_progress.json")

POLL_INTERVAL = 2
BAR_WIDTH = 40


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def build_dataset_file_map(scrape_data):
    """Build a mapping of filename -> dataset number from urls_discovered."""
    file_to_ds = {}
    for ds, urls in scrape_data.get("urls_discovered", {}).items():
        for url in urls:
            fname = url.rsplit("/", 1)[-1]
            # URL-decode %20 etc. in filename
            fname = fname.replace("%20", " ")
            file_to_ds[fname] = ds
    return file_to_ds


def get_total_files(scrape_data, dataset_filter, explicit_total):
    """Determine the total number of files to process."""
    if explicit_total is not None:
        return explicit_total

    if scrape_data is None:
        return None

    downloaded = scrape_data.get("files_downloaded", [])
    if not dataset_filter:
        return len(downloaded)

    # Filter to specific datasets using urls_discovered mapping
    file_to_ds = build_dataset_file_map(scrape_data)
    ds_set = set(dataset_filter)
    return sum(1 for f in downloaded if file_to_ds.get(f) in ds_set)


def filter_files(file_list, file_to_ds, dataset_filter):
    """Filter a file list to only those in the specified datasets."""
    if not dataset_filter:
        return file_list
    ds_set = set(dataset_filter)
    return [f for f in file_list if file_to_ds.get(f) in ds_set]


def render(reindex_data, total, dataset_filter, file_to_ds, start_time, prev_completed):
    """Render the progress display. Returns current completed count."""
    completed = reindex_data.get("completed", [])
    failed = reindex_data.get("failed", [])
    vectors = reindex_data.get("vectors_upserted", 0)

    if dataset_filter:
        completed = filter_files(completed, file_to_ds, dataset_filter)
        failed = filter_files(failed, file_to_ds, dataset_filter)

    n_completed = len(completed)
    n_failed = len(failed)
    n_processed = n_completed + n_failed

    # Progress fraction
    if total and total > 0:
        frac = min(n_completed / total, 1.0)
        pct_str = f"{frac * 100:.1f}%"
        count_str = f"{n_completed}/{total}"
    else:
        frac = 0
        pct_str = "?"
        count_str = str(n_completed)

    # Progress bar
    filled = int(BAR_WIDTH * frac)
    bar = "=" * filled
    if filled < BAR_WIDTH:
        bar += ">"
        bar += "." * (BAR_WIDTH - filled - 1)
    else:
        bar = "=" * BAR_WIDTH

    # Rate & ETA
    elapsed = time.time() - start_time
    rate_str = ""
    eta_str = ""
    if elapsed > 5 and n_completed > prev_completed[0]:
        # Use completed count change since script started
        delta = n_completed - prev_completed[0]
        rate = delta / (elapsed / 60)  # files per minute
        rate_str = f"~{rate:.1f} files/min"
        if total and total > n_completed:
            remaining = total - n_completed
            eta_secs = (remaining / rate) * 60
            if eta_secs < 60:
                eta_str = f"{eta_secs:.0f}s"
            elif eta_secs < 3600:
                eta_str = f"{eta_secs // 60:.0f}m {eta_secs % 60:.0f}s"
            else:
                h = eta_secs // 3600
                m = (eta_secs % 3600) // 60
                eta_str = f"{h:.0f}h {m:.0f}m"

    # Last file
    last_file = completed[-1] if completed else "—"

    # Dataset label
    ds_label = ""
    if dataset_filter:
        ds_label = f"  (datasets {','.join(dataset_filter)})"

    # Build output lines
    lines = []
    lines.append(f"\033[1m Reindex Progress{ds_label}\033[0m")
    lines.append(f" [{bar}] {count_str} ({pct_str})")
    lines.append(f" Completed: \033[32m{n_completed:,}\033[0m | Failed: \033[31m{n_failed:,}\033[0m | Vectors: \033[36m{vectors:,}\033[0m")

    rate_parts = []
    if rate_str:
        rate_parts.append(f"Rate: {rate_str}")
    if eta_str:
        rate_parts.append(f"ETA: {eta_str}")
    if rate_parts:
        lines.append(f" {' | '.join(rate_parts)}")
    else:
        lines.append(f" Calculating rate...")

    lines.append(f" Last file: {last_file}")

    # Move cursor up and overwrite (6 lines: 5 content + 1 blank)
    output = "\033[6A\033[J" + "\n".join(lines) + "\n"
    sys.stdout.write(output)
    sys.stdout.flush()

    return n_completed


def main():
    parser = argparse.ArgumentParser(description="Watch reindex pipeline progress in real-time")
    parser.add_argument("--total", type=int, default=None, help="Override total file count")
    parser.add_argument("--dataset", type=str, default=None, help="Filter to specific datasets, comma-separated (e.g., 1,2,4,7,6)")
    parser.add_argument("--interval", type=int, default=POLL_INTERVAL, help="Poll interval in seconds (default: 2)")
    args = parser.parse_args()

    dataset_filter = None
    if args.dataset:
        dataset_filter = [s.strip() for s in args.dataset.split(",")]

    # Load scrape progress for total count and dataset mapping
    scrape_data = load_json(SCRAPE_PATH)
    total = get_total_files(scrape_data, dataset_filter, args.total)
    file_to_ds = {}
    if dataset_filter and scrape_data:
        file_to_ds = build_dataset_file_map(scrape_data)

    # Get initial completed count for rate calculation
    reindex_data = load_json(REINDEX_PATH)
    initial_completed = 0
    if reindex_data:
        completed_list = reindex_data.get("completed", [])
        if dataset_filter:
            completed_list = filter_files(completed_list, file_to_ds, dataset_filter)
        initial_completed = len(completed_list)

    prev_completed = [initial_completed]  # mutable for closure
    start_time = time.time()

    # Print header + blank lines so first render can overwrite
    total_str = f"of {total:,}" if total else "(unknown total)"
    print(f"\n Watching {REINDEX_PATH}")
    print(f" Total files: {total_str}")
    print(f" Press Ctrl+C to exit\n")
    # Print 6 blank lines for the display area
    sys.stdout.write("\n" * 6)
    sys.stdout.flush()

    # Clean exit on Ctrl+C
    def handle_sigint(sig, frame):
        sys.stdout.write("\n\033[0m Stopped.\n")
        sys.exit(0)
    signal.signal(signal.SIGINT, handle_sigint)

    while True:
        reindex_data = load_json(REINDEX_PATH)
        if reindex_data is None:
            sys.stdout.write("\033[6A\033[J")
            sys.stdout.write(f" Waiting for {REINDEX_PATH}...\n\n\n\n\n\n")
            sys.stdout.flush()
        else:
            render(reindex_data, total, dataset_filter, file_to_ds, start_time, prev_completed)

        time.sleep(args.interval)


if __name__ == "__main__":
    main()

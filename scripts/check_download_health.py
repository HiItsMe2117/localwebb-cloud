#!/usr/bin/env python3
"""Health check for the Dataset 11 download process."""

import os
import re
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path

LOG_FILE = Path(__file__).parent.parent / "logs" / "dataset11_download.log"
TOTAL_FILES = 326195
PID = None


def find_pid():
    """Find the scraper process PID."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "scrape_doj.py.*--dataset 11"],
            capture_output=True, text=True
        )
        pids = result.stdout.strip().split("\n")
        return int(pids[0]) if pids[0] else None
    except Exception:
        return None


def is_running(pid):
    """Check if a PID is alive."""
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def get_process_uptime(pid):
    """Get how long the process has been running."""
    if not pid:
        return None
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "etime="],
            capture_output=True, text=True
        )
        elapsed = result.stdout.strip()
        if not elapsed:
            return None
        # Parse elapsed time (formats: MM:SS, HH:MM:SS, D-HH:MM:SS)
        parts = elapsed.replace("-", ":").split(":")
        parts = [int(p) for p in parts]
        if len(parts) == 2:
            return timedelta(minutes=parts[0], seconds=parts[1])
        elif len(parts) == 3:
            return timedelta(hours=parts[0], minutes=parts[1], seconds=parts[2])
        elif len(parts) == 4:
            return timedelta(days=parts[0], hours=parts[1], minutes=parts[2], seconds=parts[3])
    except Exception:
        return None


def parse_log():
    """Parse the log file for stats."""
    if not LOG_FILE.exists():
        return None

    stats = {
        "uploaded": 0,
        "failed": 0,
        "skipped": 0,
        "retries": 0,
        "current_index": 0,
        "last_file": "",
        "errors": [],
        "total_mb": 0.0,
        "gcs_existing": 0,
    }

    with open(LOG_FILE, "r") as f:
        for line in f:
            if "Uploaded:" in line:
                stats["uploaded"] += 1
                mb_match = re.search(r"\((\d+\.\d+) MB\)", line)
                if mb_match:
                    stats["total_mb"] += float(mb_match.group(1))

            elif "FAILED:" in line:
                stats["failed"] += 1
                stats["errors"].append(line.strip())

            elif line.strip().startswith("Retry"):
                stats["retries"] += 1

            elif "Already exists" in line or "Skipping" in line:
                stats["skipped"] += 1

            idx_match = re.search(r"\[(\d+)/326195\]", line)
            if idx_match:
                idx = int(idx_match.group(1))
                if idx > stats["current_index"]:
                    stats["current_index"] = idx
                    file_match = re.search(r"\] (.+)$", line)
                    if file_match:
                        stats["last_file"] = file_match.group(1).strip()

            if "Found" in line and "existing files in GCS" in line:
                m = re.search(r"Found (\d+) existing", line)
                if m:
                    stats["gcs_existing"] = int(m.group(1))

    return stats


def format_duration(td):
    """Format a timedelta nicely."""
    total_secs = int(td.total_seconds())
    days = total_secs // 86400
    hours = (total_secs % 86400) // 3600
    mins = (total_secs % 3600) // 60
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if mins > 0:
        parts.append(f"{mins}m")
    if not parts:
        parts.append(f"{total_secs}s")
    return " ".join(parts)


def main():
    pid = find_pid()
    running = is_running(pid)
    uptime = get_process_uptime(pid)
    stats = parse_log()

    print()
    print("=" * 60)
    print("  Dataset 11 Download Health Check")
    print("=" * 60)
    print()

    # Process status
    if running:
        status = f"\033[92mRUNNING\033[0m (PID {pid})"
    else:
        status = "\033[91mNOT RUNNING\033[0m"
    print(f"  Status:       {status}")

    if uptime:
        print(f"  Uptime:       {format_duration(uptime)}")

    if not stats:
        print(f"\n  No log file found at {LOG_FILE}")
        print()
        return

    print()

    # Progress
    total_done = stats["gcs_existing"] + stats["uploaded"]
    remaining = TOTAL_FILES - stats["current_index"]
    pct = (stats["current_index"] / TOTAL_FILES) * 100

    bar_width = 40
    filled = int(bar_width * pct / 100)
    bar = "\033[92m" + "█" * filled + "\033[0m" + "░" * (bar_width - filled)
    print(f"  Progress:     [{bar}] {pct:.1f}%")
    print(f"  Current:      [{stats['current_index']:,} / {TOTAL_FILES:,}]")
    print(f"  Last file:    {stats['last_file']}")
    print()

    # Download stats
    print(f"  Uploaded:     {stats['uploaded']:,} files ({stats['total_mb']:.1f} MB)")
    print(f"  Pre-existing: {stats['gcs_existing']:,} files (already in GCS)")
    print(f"  Failed:       {stats['failed']:,} files")
    print(f"  Retries:      {stats['retries']:,}")
    print()

    # Speed & ETA
    if uptime and stats["uploaded"] > 0:
        elapsed_mins = uptime.total_seconds() / 60
        speed = stats["uploaded"] / elapsed_mins
        print(f"  Speed:        {speed:.1f} files/min ({speed/60:.2f} files/sec)")

        if speed > 0 and remaining > 0:
            eta_mins = remaining / speed
            eta = timedelta(minutes=eta_mins)
            finish_time = datetime.now() + eta
            print(f"  Remaining:    {remaining:,} files")
            print(f"  ETA:          {format_duration(eta)} (~ {finish_time.strftime('%b %d %I:%M %p')})")
        print()

    # Error rate
    total_attempted = stats["uploaded"] + stats["failed"]
    if total_attempted > 0:
        error_rate = (stats["failed"] / total_attempted) * 100
        if error_rate < 1:
            color = "\033[92m"  # green
        elif error_rate < 5:
            color = "\033[93m"  # yellow
        else:
            color = "\033[91m"  # red
        print(f"  Error rate:   {color}{error_rate:.2f}%\033[0m ({stats['failed']}/{total_attempted})")
    print()

    # Recent errors
    if stats["errors"]:
        print("  Recent errors (last 5):")
        for err in stats["errors"][-5:]:
            # Truncate long error lines
            if len(err) > 80:
                err = err[:77] + "..."
            print(f"    - {err}")
        print()

    # Overall health verdict
    print("-" * 60)
    if not running:
        print("  \033[91m⚠  Process is not running! Check if it crashed.\033[0m")
        print(f"     Last log lines:  tail -20 {LOG_FILE}")
    elif stats["failed"] > 0 and total_attempted > 0 and (stats["failed"] / total_attempted) > 0.05:
        print("  \033[93m⚠  High error rate — may want to investigate.\033[0m")
    else:
        print("  \033[92m✓  Everything looks healthy.\033[0m")
    print("-" * 60)
    print()


if __name__ == "__main__":
    main()

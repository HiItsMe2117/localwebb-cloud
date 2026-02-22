"""
Audit vector quality in the Pinecone index.

Samples ~400-600 vectors using semantic probe queries and random vectors,
then runs quality checks and prints a structured terminal report.

Usage:
    python3 scripts/audit_vectors.py                     # Full audit with semantic probes
    python3 scripts/audit_vectors.py --no-embed           # Random-only sampling (no Gemini cost)
    python3 scripts/audit_vectors.py --json results.json  # Also save findings to JSON
"""

import os
import sys
import json
import time
import hashlib
import argparse
import statistics
import re
import random
import math
from pathlib import Path
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env.prod"

PINECONE_QUERY_DELAY = 0.5  # seconds between Pinecone queries (free-tier safe)
EMBED_DELAY = 1.0           # seconds between embedding calls
VECTOR_DIM = 3072           # gemini-embedding-001 dimension

SEMANTIC_PROBES = [
    "Jeffrey Epstein",
    "Ghislaine Maxwell",
    "flight log passenger manifest tail number",
    "deposition testimony under oath",
    "minor victim sexual abuse",
    "financial wire transfer account",
    "Palm Beach FBI investigation",
    "plea agreement non-prosecution",
]

# Investigation relevance keywords
KEY_PEOPLE = [
    "epstein", "maxwell", "prince andrew", "wexner", "dershowitz",
    "clinton", "trump", "brunel", "dubin", "black", "staley",
    "giuffre", "roberts", "farmer", "ward", "marcinkova",
]
KEY_ORGS = ["fbi", "doj", "sdny", "sec", "irs", "palm beach police",
            "department of justice", "southern district"]
KEY_LOCATIONS = ["palm beach", "little saint james", "zorro ranch",
                 "new york", "71st street", "el brillo"]


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
    """Classify which DOJ data set a file belongs to based on its name."""
    fname = filename.lower()
    for i in [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]:
        for pattern in [f"dataset{i}", f"data-set-{i}", f"dataset-{i}",
                        f"data_set_{i}", f"dataset {i}", f"dataset%20{i}"]:
            idx = fname.find(pattern)
            if idx >= 0:
                end_pos = idx + len(pattern)
                if end_pos >= len(fname) or not fname[end_pos].isdigit():
                    return str(i)
    if fname.startswith("uploads/"):
        return "9"
    return "unknown"


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

def make_random_unit_vectors(n, dim=VECTOR_DIM):
    """Generate n random unit vectors (normalized gaussian, pure Python)."""
    vectors = []
    for _ in range(n):
        vec = [random.gauss(0, 1) for _ in range(dim)]
        norm = math.sqrt(sum(x * x for x in vec))
        vectors.append([x / norm for x in vec])
    return vectors


def embed_probes(genai_client, probes):
    """Embed semantic probe strings via gemini-embedding-001."""
    vectors = []
    for probe in probes:
        time.sleep(EMBED_DELAY)
        res = genai_client.models.embed_content(
            model="gemini-embedding-001",
            contents=[probe],
        )
        vectors.append(res.embeddings[0].values)
        print(f"  Embedded: \"{probe}\"")
    return vectors


def sample_vectors(index, probe_vectors, probe_labels, top_k=50):
    """Query Pinecone with probe vectors and collect unique matches."""
    seen_ids = set()
    samples = []  # list of (id, metadata, score, probe_label)

    for vec, label in zip(probe_vectors, probe_labels):
        time.sleep(PINECONE_QUERY_DELAY)
        result = index.query(vector=vec, top_k=top_k, include_metadata=True)
        new = 0
        for match in result.matches:
            if match.id not in seen_ids:
                seen_ids.add(match.id)
                samples.append((match.id, match.metadata or {}, match.score, label))
                new += 1
        print(f"  [{label[:50]:50s}] {len(result.matches)} hits, {new} new  (total: {len(samples)})")

    return samples


# ---------------------------------------------------------------------------
# Quality Checks
# ---------------------------------------------------------------------------

def check_index_stats(index):
    """Check 1: Index-level stats."""
    stats = index.describe_index_stats()
    total = stats.total_vector_count
    dim = stats.dimension
    ns = dict(stats.namespaces) if stats.namespaces else {}
    return {
        "total_vectors": total,
        "dimension": dim,
        "namespaces": {k: v.vector_count for k, v in ns.items()} if ns else {"default": total},
    }


def check_text_quality(samples):
    """Check 2: Text quality — length distribution, empty/short, garbled OCR."""
    lengths = []
    empty = 0
    short = 0  # < 100 chars
    high_nonascii = 0
    nonascii_ratios = []

    for vid, meta, score, label in samples:
        text = meta.get("text", "") or ""
        length = len(text)
        lengths.append(length)

        if length == 0:
            empty += 1
        elif length < 100:
            short += 1

        if length > 0:
            nonascii = sum(1 for c in text if ord(c) > 127)
            ratio = nonascii / length
            nonascii_ratios.append(ratio)
            if ratio > 0.15:
                high_nonascii += 1

    n = len(samples)
    pcts = {}
    if lengths:
        lengths_sorted = sorted(lengths)
        pcts = {
            "min": lengths_sorted[0],
            "p10": lengths_sorted[int(n * 0.10)] if n > 10 else lengths_sorted[0],
            "p50": lengths_sorted[int(n * 0.50)] if n > 2 else lengths_sorted[0],
            "p90": lengths_sorted[int(n * 0.90)] if n > 10 else lengths_sorted[-1],
            "max": lengths_sorted[-1],
        }

    return {
        "sampled": n,
        "empty": empty,
        "short_under_100": short,
        "high_nonascii_over_15pct": high_nonascii,
        "length_distribution": pcts,
        "mean_nonascii_ratio": round(statistics.mean(nonascii_ratios), 4) if nonascii_ratios else 0,
    }


def check_metadata_completeness(samples):
    """Check 3: Metadata completeness — people/orgs/dates/doc_type/page."""
    n = len(samples)
    empty_people = 0
    empty_orgs = 0
    empty_dates = 0
    missing_page = 0
    doc_types = Counter()

    for vid, meta, score, label in samples:
        people = meta.get("people", []) or []
        orgs = meta.get("organizations", []) or []
        dates = meta.get("dates", []) or []
        doc_type = meta.get("doc_type", "MISSING")
        page = meta.get("page")

        if not people:
            empty_people += 1
        if not orgs:
            empty_orgs += 1
        if not dates:
            empty_dates += 1
        if page is None:
            missing_page += 1
        doc_types[doc_type] += 1

    return {
        "sampled": n,
        "empty_people_pct": round(100 * empty_people / max(n, 1), 1),
        "empty_orgs_pct": round(100 * empty_orgs / max(n, 1), 1),
        "empty_dates_pct": round(100 * empty_dates / max(n, 1), 1),
        "missing_page_pct": round(100 * missing_page / max(n, 1), 1),
        "doc_type_distribution": dict(doc_types.most_common()),
    }


def check_dataset_coverage(samples):
    """Check 4: Dataset coverage — vectors per dataset, gaps."""
    ds_counts = Counter()
    for vid, meta, score, label in samples:
        filename = meta.get("filename", "") or ""
        gcs_path = meta.get("gcs_path", "") or ""
        # Use gcs_path for classification (more info), fallback to filename
        classify_input = gcs_path if gcs_path else filename
        ds = classify_dataset(classify_input)
        ds_counts[ds] += 1

    # Check for gaps (datasets 1-12 that have zero sampled vectors)
    gaps = [str(i) for i in range(1, 13) if str(i) not in ds_counts]

    return {
        "dataset_counts": dict(ds_counts.most_common()),
        "datasets_with_zero_samples": gaps,
    }


def check_duplicates(samples):
    """Check 5: Duplicate detection — exact text + filename+chunk collisions."""
    text_hashes = defaultdict(list)
    file_chunk_keys = defaultdict(list)

    for vid, meta, score, label in samples:
        text = meta.get("text", "") or ""
        # Normalize: strip whitespace, lowercase for dedup
        normalized = re.sub(r'\s+', ' ', text.strip().lower())
        h = hashlib.sha256(normalized.encode()).hexdigest()
        text_hashes[h].append(vid)

        filename = meta.get("filename", "")
        chunk_index = meta.get("chunk_index", "")
        if filename and chunk_index != "":
            key = f"{filename}|{chunk_index}"
            file_chunk_keys[key].append(vid)

    exact_dupes = {h: ids for h, ids in text_hashes.items() if len(ids) > 1}
    chunk_collisions = {k: ids for k, ids in file_chunk_keys.items() if len(ids) > 1}

    return {
        "exact_text_duplicate_groups": len(exact_dupes),
        "total_duplicate_vectors": sum(len(ids) - 1 for ids in exact_dupes.values()),
        "filename_chunk_collisions": len(chunk_collisions),
        "example_dupes": {h: ids[:3] for h, ids in list(exact_dupes.items())[:5]},
        "example_collisions": {k: ids[:3] for k, ids in list(chunk_collisions.items())[:5]},
    }


def check_entity_quality(samples):
    """Check 6: Entity extraction quality — frequent people/orgs, false positives."""
    all_people = Counter()
    all_orgs = Counter()
    single_word_people = Counter()
    short_orgs = Counter()  # orgs with <= 3 chars
    truncated_people = 0  # vectors with exactly 20 people (list cap)
    truncated_orgs = 0

    for vid, meta, score, label in samples:
        people = meta.get("people", []) or []
        orgs = meta.get("organizations", []) or []

        for p in people:
            all_people[p] += 1
            if " " not in p.strip():
                single_word_people[p] += 1

        for o in orgs:
            all_orgs[o] += 1
            if len(o.strip()) <= 3:
                short_orgs[o] += 1

        if len(people) == 20:
            truncated_people += 1
        if len(orgs) == 20:
            truncated_orgs += 1

    return {
        "top_20_people": dict(all_people.most_common(20)),
        "top_20_orgs": dict(all_orgs.most_common(20)),
        "single_word_people_flag": dict(single_word_people.most_common(10)),
        "very_short_orgs_flag": dict(short_orgs.most_common(10)),
        "vectors_with_truncated_people_list": truncated_people,
        "vectors_with_truncated_orgs_list": truncated_orgs,
    }


def check_investigation_relevance(samples):
    """Check 7: Investigation relevance — hit rates for key entities/locations."""
    n = len(samples)
    people_hits = Counter()
    org_hits = Counter()
    location_hits = Counter()
    zero_signal = 0

    for vid, meta, score, label in samples:
        text = (meta.get("text", "") or "").lower()
        found_any = False

        for name in KEY_PEOPLE:
            if name in text:
                people_hits[name] += 1
                found_any = True

        for org in KEY_ORGS:
            if org in text:
                org_hits[org] += 1
                found_any = True

        for loc in KEY_LOCATIONS:
            if loc in text:
                location_hits[loc] += 1
                found_any = True

        if not found_any:
            zero_signal += 1

    return {
        "sampled": n,
        "key_people_hits": dict(people_hits.most_common()),
        "key_org_hits": dict(org_hits.most_common()),
        "key_location_hits": dict(location_hits.most_common()),
        "zero_signal_vectors": zero_signal,
        "zero_signal_pct": round(100 * zero_signal / max(n, 1), 1),
    }


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def print_report(results):
    """Print structured terminal report."""
    W = 70

    def header(title, num):
        print(f"\n{'='*W}")
        print(f"  CHECK {num}: {title}")
        print(f"{'='*W}")

    def row(label, value, indent=2):
        print(f"{' '*indent}{label:40s} {value}")

    # --- Check 1: Index Stats ---
    header("INDEX STATS", 1)
    s = results["index_stats"]
    row("Total vectors:", f"{s['total_vectors']:,}")
    row("Dimension:", str(s['dimension']))
    for ns, count in s["namespaces"].items():
        row(f"  Namespace '{ns}':", f"{count:,}")

    # --- Check 2: Text Quality ---
    header("TEXT QUALITY", 2)
    t = results["text_quality"]
    row("Sampled vectors:", str(t["sampled"]))
    row("Empty text (0 chars):", str(t["empty"]))
    row("Short text (<100 chars):", str(t["short_under_100"]))
    row("High non-ASCII (>15%):", str(t["high_nonascii_over_15pct"]))
    row("Mean non-ASCII ratio:", f"{t['mean_nonascii_ratio']:.4f}")
    if t["length_distribution"]:
        d = t["length_distribution"]
        row("Length distribution:", f"min={d['min']}  p10={d['p10']}  p50={d['p50']}  p90={d['p90']}  max={d['max']}")

    # --- Check 3: Metadata Completeness ---
    header("METADATA COMPLETENESS", 3)
    m = results["metadata_completeness"]
    row("Sampled vectors:", str(m["sampled"]))
    row("Empty people list:", f"{m['empty_people_pct']}%")
    row("Empty organizations list:", f"{m['empty_orgs_pct']}%")
    row("Empty dates list:", f"{m['empty_dates_pct']}%")
    row("Missing page number:", f"{m['missing_page_pct']}%")
    print(f"\n  Doc-type distribution:")
    for dt, count in m["doc_type_distribution"].items():
        pct = round(100 * count / max(m["sampled"], 1), 1)
        print(f"    {dt:30s} {count:5d}  ({pct}%)")

    # --- Check 4: Dataset Coverage ---
    header("DATASET COVERAGE", 4)
    c = results["dataset_coverage"]
    for ds, count in sorted(c["dataset_counts"].items(), key=lambda x: (-x[1], x[0])):
        label = f"Data Set {ds}" if ds != "unknown" else "Unknown"
        print(f"    {label:30s} {count:5d} vectors")
    if c["datasets_with_zero_samples"]:
        print(f"\n  GAPS — datasets with 0 sampled vectors: {', '.join(c['datasets_with_zero_samples'])}")
    else:
        print(f"\n  No gaps — all datasets 1-12 represented in sample.")

    # --- Check 5: Duplicate Detection ---
    header("DUPLICATE DETECTION", 5)
    dup = results["duplicates"]
    row("Exact-text duplicate groups:", str(dup["exact_text_duplicate_groups"]))
    row("Total duplicate vectors:", str(dup["total_duplicate_vectors"]))
    row("Filename+chunk collisions:", str(dup["filename_chunk_collisions"]))
    if dup["example_dupes"]:
        print(f"\n  Example duplicate groups:")
        for h, ids in dup["example_dupes"].items():
            print(f"    {h[:16]}... -> {ids}")
    if dup["example_collisions"]:
        print(f"\n  Example chunk collisions:")
        for k, ids in dup["example_collisions"].items():
            print(f"    {k} -> {ids}")

    # --- Check 6: Entity Extraction Quality ---
    header("ENTITY EXTRACTION QUALITY", 6)
    e = results["entity_quality"]
    print(f"\n  Top-20 People:")
    for name, count in e["top_20_people"].items():
        print(f"    {name:40s} {count:5d}")
    print(f"\n  Top-20 Organizations:")
    for name, count in e["top_20_orgs"].items():
        print(f"    {name:40s} {count:5d}")
    if e["single_word_people_flag"]:
        print(f"\n  FALSE-POSITIVE FLAGS — Single-word people:")
        for name, count in e["single_word_people_flag"].items():
            print(f"    {name:40s} {count:5d}")
    if e["very_short_orgs_flag"]:
        print(f"\n  FALSE-POSITIVE FLAGS — Very short orgs (<=3 chars):")
        for name, count in e["very_short_orgs_flag"].items():
            print(f"    {name:40s} {count:5d}")
    row("Vectors with truncated people (=20):", str(e["vectors_with_truncated_people_list"]))
    row("Vectors with truncated orgs (=20):", str(e["vectors_with_truncated_orgs_list"]))

    # --- Check 7: Investigation Relevance ---
    header("INVESTIGATION RELEVANCE", 7)
    r = results["investigation_relevance"]
    row("Sampled vectors:", str(r["sampled"]))
    row("Zero-signal vectors:", f"{r['zero_signal_vectors']} ({r['zero_signal_pct']}%)")
    print(f"\n  Key people hit rates:")
    for name, count in sorted(r["key_people_hits"].items(), key=lambda x: -x[1]):
        pct = round(100 * count / max(r["sampled"], 1), 1)
        print(f"    {name:30s} {count:5d}  ({pct}%)")
    print(f"\n  Key org hit rates:")
    for name, count in sorted(r["key_org_hits"].items(), key=lambda x: -x[1]):
        pct = round(100 * count / max(r["sampled"], 1), 1)
        print(f"    {name:30s} {count:5d}  ({pct}%)")
    print(f"\n  Key location hit rates:")
    for name, count in sorted(r["key_location_hits"].items(), key=lambda x: -x[1]):
        pct = round(100 * count / max(r["sampled"], 1), 1)
        print(f"    {name:30s} {count:5d}  ({pct}%)")

    # --- Recommendations ---
    print(f"\n{'='*W}")
    print(f"  RECOMMENDATIONS")
    print(f"{'='*W}")
    recs = []

    t = results["text_quality"]
    if t["empty"] > 0:
        recs.append(f"{t['empty']} vectors have EMPTY text — these contribute nothing to search. Consider deleting them.")
    if t["short_under_100"] > 5:
        pct = round(100 * t["short_under_100"] / max(t["sampled"], 1), 1)
        recs.append(f"{t['short_under_100']} vectors ({pct}%) have very short text (<100 chars) — may be low-value fragments.")
    if t["high_nonascii_over_15pct"] > 0:
        recs.append(f"{t['high_nonascii_over_15pct']} vectors have high non-ASCII ratio (>15%) — likely garbled OCR. Re-process with Gemini vision.")

    m = results["metadata_completeness"]
    if m["empty_people_pct"] > 30:
        recs.append(f"{m['empty_people_pct']}% of vectors have no people extracted — regex may miss all-caps OCR text or non-standard name formats.")
    if m["empty_orgs_pct"] > 60:
        recs.append(f"{m['empty_orgs_pct']}% of vectors have no organizations — consider broadening org regex or using NER.")
    other_pct = round(100 * m["doc_type_distribution"].get("other", 0) / max(m["sampled"], 1), 1)
    if other_pct > 40:
        recs.append(f"{other_pct}% of vectors classified as doc_type='other' — consider adding more classification keywords.")

    c = results["dataset_coverage"]
    if c["datasets_with_zero_samples"]:
        recs.append(f"Datasets {', '.join(c['datasets_with_zero_samples'])} have 0 sampled vectors — may indicate missing data or classification issues.")

    dup = results["duplicates"]
    if dup["total_duplicate_vectors"] > 0:
        recs.append(f"{dup['total_duplicate_vectors']} exact-duplicate vectors detected — consider deduplication to reduce index noise.")
    if dup["filename_chunk_collisions"] > 0:
        recs.append(f"{dup['filename_chunk_collisions']} filename+chunk_index collisions — possible re-indexing artifacts.")

    e = results["entity_quality"]
    if e["vectors_with_truncated_people_list"] > 10:
        recs.append(f"{e['vectors_with_truncated_people_list']} vectors hit the 20-person cap — entity lists may be truncated.")

    r = results["investigation_relevance"]
    if r["zero_signal_pct"] > 30:
        recs.append(f"{r['zero_signal_pct']}% of vectors have zero investigation-relevant signals — may be boilerplate, headers, or off-topic content.")

    if recs:
        for i, rec in enumerate(recs, 1):
            print(f"\n  {i}. {rec}")
    else:
        print(f"\n  No major issues detected. Vector quality looks good!")
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Audit vector quality in Pinecone")
    parser.add_argument("--no-embed", action="store_true",
                        help="Skip Gemini embedding calls, use only random vectors")
    parser.add_argument("--json", type=str, metavar="FILE",
                        help="Also save findings to a JSON file")
    args = parser.parse_args()

    print("=" * 70)
    print("  PINECONE VECTOR QUALITY AUDIT")
    print("=" * 70)

    # Load environment
    env = load_env()

    # Initialize Pinecone
    from pinecone import Pinecone
    pc = Pinecone(api_key=env["PINECONE_API_KEY"])
    index = pc.Index("localwebb")

    start_time = time.time()

    # -----------------------------------------------------------------------
    # Check 1: Index Stats
    # -----------------------------------------------------------------------
    print("\n[1/7] Fetching index stats...")
    index_stats = check_index_stats(index)
    print(f"  {index_stats['total_vectors']:,} vectors, {index_stats['dimension']}-dim")

    # -----------------------------------------------------------------------
    # Sampling
    # -----------------------------------------------------------------------
    print(f"\n{'─'*70}")
    print("SAMPLING VECTORS")
    print(f"{'─'*70}")

    probe_vectors = []
    probe_labels = []

    if not args.no_embed:
        print("\nEmbedding semantic probes via Gemini...")
        from google import genai
        genai_client = genai.Client(api_key=env["GOOGLE_API_KEY"])
        semantic_vecs = embed_probes(genai_client, SEMANTIC_PROBES)
        probe_vectors.extend(semantic_vecs)
        probe_labels.extend(SEMANTIC_PROBES)
    else:
        print("\n--no-embed: skipping semantic probes")

    # Random vectors for coverage
    print(f"\nGenerating 5 random unit vectors ({VECTOR_DIM}-dim)...")
    random_vecs = make_random_unit_vectors(5, VECTOR_DIM)
    probe_vectors.extend(random_vecs)
    probe_labels.extend([f"random-{i}" for i in range(5)])

    print(f"\nQuerying Pinecone with {len(probe_vectors)} probes (top_k=50 each)...")
    samples = sample_vectors(index, probe_vectors, probe_labels, top_k=50)
    print(f"\nTotal unique vectors sampled: {len(samples)}")

    # -----------------------------------------------------------------------
    # Run quality checks
    # -----------------------------------------------------------------------
    print(f"\n{'─'*70}")
    print("RUNNING QUALITY CHECKS")
    print(f"{'─'*70}")

    print("\n[2/7] Text quality...")
    text_quality = check_text_quality(samples)

    print("[3/7] Metadata completeness...")
    metadata_completeness = check_metadata_completeness(samples)

    print("[4/7] Dataset coverage...")
    dataset_coverage = check_dataset_coverage(samples)

    print("[5/7] Duplicate detection...")
    duplicates = check_duplicates(samples)

    print("[6/7] Entity extraction quality...")
    entity_quality = check_entity_quality(samples)

    print("[7/7] Investigation relevance...")
    investigation_relevance = check_investigation_relevance(samples)

    elapsed = time.time() - start_time
    print(f"\nAll checks complete in {elapsed:.1f}s")

    # -----------------------------------------------------------------------
    # Results
    # -----------------------------------------------------------------------
    results = {
        "index_stats": index_stats,
        "text_quality": text_quality,
        "metadata_completeness": metadata_completeness,
        "dataset_coverage": dataset_coverage,
        "duplicates": duplicates,
        "entity_quality": entity_quality,
        "investigation_relevance": investigation_relevance,
        "audit_meta": {
            "sampled_vectors": len(samples),
            "probes_used": len(probe_vectors),
            "semantic_probes": 0 if args.no_embed else len(SEMANTIC_PROBES),
            "random_probes": 5,
            "elapsed_seconds": round(elapsed, 1),
        },
    }

    # Print terminal report
    print_report(results)

    # Optionally save to JSON
    if args.json:
        out_path = Path(args.json)
        out_path.write_text(json.dumps(results, indent=2, default=str))
        print(f"Results saved to: {out_path}")


if __name__ == "__main__":
    main()

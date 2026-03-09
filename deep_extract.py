"""
Deep targeted extraction for a specific entity/topic.

Usage: python deep_extract.py "Israel"
       python deep_extract.py "Karim Wade" --entity-id karim

Fetches ALL document chunks mentioning the search term from Supabase,
batches them, sends each batch to Gemini 2.5 Pro for entity/relationship
extraction with quality filtering, and upserts results into Supabase.
"""

import os
import re
import sys
import math
import time
import argparse
from dotenv import load_dotenv
from supabase import create_client
from google import genai
from google.genai import types
from pydantic import BaseModel
from typing import List

load_dotenv()

# --- Clients ---
sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))
google_client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

# --- Schema ---
class Entity(BaseModel):
    id: str
    label: str
    type: str
    description: str
    aliases: List[str] = []

class Triple(BaseModel):
    subject_id: str
    predicate: str
    object_id: str
    evidence_text: str
    source_filename: str
    source_page: int = 0
    confidence: str = "STATED"
    date_mentioned: str = ""

class CaseMap(BaseModel):
    entities: List[Entity]
    triples: List[Triple]

# --- Quality gate (matches api/index.py) ---
_DOC_ID_RE = re.compile(r'^e[a-z]?[fpuh]?ta\d', re.IGNORECASE)
_GENERIC_DESC_RE = re.compile(
    r'^(a |an )?(person|individual|entity|organization|document|location|someone|something)?\s*'
    r'(mentioned|referenced|noted|found|listed|described)\s*(in|within)',
    re.IGNORECASE
)
_BAD_TYPES = {"DOCUMENT", "OBJECT", "VEHICLE", "DEVICE"}

def filter_quality(entities):
    quality = []
    rejected = 0
    for ent in entities:
        label = ent.label.strip()
        if len(label) <= 2:
            rejected += 1; continue
        if _DOC_ID_RE.match(label) or _DOC_ID_RE.match(ent.id):
            rejected += 1; continue
        if ent.type.upper() in _BAD_TYPES:
            rejected += 1; continue
        if _GENERIC_DESC_RE.match(ent.description.strip()) and len(ent.description) < 60:
            rejected += 1; continue
        quality.append(ent)
    return quality, rejected

# --- Args ---
parser = argparse.ArgumentParser(description="Deep targeted entity extraction")
parser.add_argument("search_term", help="Term to search for in document chunks")
parser.add_argument("--entity-id", help="Canonical entity ID to use (e.g., 'karim')")
parser.add_argument("--batch-size", type=int, default=25, help="Chunks per Gemini batch")
parser.add_argument("--dry-run", action="store_true", help="Extract but don't upsert")
args = parser.parse_args()

SEARCH_TERM = args.search_term
ENTITY_ID = args.entity_id
BATCH_SIZE = args.batch_size

# --- Fetch all matching chunks (paginated) ---
print(f"Fetching all document chunks mentioning \"{SEARCH_TERM}\"...")
all_chunks = []
offset = 0
PAGE_SIZE = 500
while True:
    res = sb.rpc('search_chunks_exact', {
        'search_query': SEARCH_TERM,
        'result_limit': PAGE_SIZE,
        'result_offset': offset
    }).execute()
    page = res.data or []
    all_chunks.extend(page)
    if len(page) < PAGE_SIZE:
        break
    offset += PAGE_SIZE
    print(f"  Fetched {len(all_chunks)} chunks so far...")

filenames = set(c.get('filename', '') for c in all_chunks)
print(f"Found {len(all_chunks)} chunks across {len(filenames)} documents")

if not all_chunks:
    print("No chunks found. Exiting.")
    sys.exit(0)

# --- Batch and extract ---
batches = [all_chunks[i:i+BATCH_SIZE] for i in range(0, len(all_chunks), BATCH_SIZE)]
print(f"Processing in {len(batches)} batches of ~{BATCH_SIZE}...")

all_entities = {}
all_triples = []
seen_edge_ids = set()
total_rejected = 0

# Build prompt
entity_focus = ""
entity_id_rule = ""
if ENTITY_ID:
    entity_focus = f"Focus especially on the entity \"{SEARCH_TERM}\" — capture ALL of its connections, activities, and relationships.\n"
    entity_id_rule = f"3. Use '{ENTITY_ID}' as the entity id for {SEARCH_TERM} and its variants.\n"

PROMPT_TEMPLATE = (
    "You are an investigative intelligence analyst. Extract entities and their relationships from these documents.\n"
    f"{entity_focus}\n"
    "RULES:\n"
    "1. Every entity needs an id (lowercase_snake_case), a label (display name), a type (PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY), a description, and aliases.\n"
    "2. Every relationship (triple) MUST include:\n"
    "   - subject_id and object_id referencing entity ids\n"
    "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
    "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
    "   - source_filename: the filename from the [Source: ...] header\n"
    "   - source_page: the page number from the [Source: ...] header\n"
    "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
    "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, empty string otherwise\n"
    f"{entity_id_rule}"
    "4. Do NOT create entities for document filenames or IDs (e.g., 'EFTA02341172').\n"
    "5. Do NOT create entities for single initials or 1-2 character labels.\n"
    "6. Do NOT create entities for generic or unidentifiable references.\n"
    "7. Every entity MUST have a meaningful description — not just 'mentioned in the document'.\n"
    "8. Only use types: PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY.\n"
    "9. Do NOT invent relationships that aren't supported by the text.\n"
    "10. Extract ALL entities and relationships the documents support.\n\n"
    "DOCUMENTS:\n{context}\n\n"
    "Return JSON with 'entities' and 'triples' keys."
)

for batch_idx, batch in enumerate(batches):
    print(f"\n--- Batch {batch_idx + 1}/{len(batches)} ({len(batch)} chunks) ---")

    context_parts = []
    for chunk in batch:
        text = chunk.get("text", "")
        filename = chunk.get("filename", "unknown")
        page = chunk.get("page", 0)
        if text:
            context_parts.append(f"[Source: {filename}, Page: {page}]\n{text}")

    context = "\n\n---\n\n".join(context_parts)
    prompt = PROMPT_TEMPLATE.format(context=context)

    try:
        res = google_client.models.generate_content(
            model="gemini-2.5-pro",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )
        output = res.parsed
        quality, rejected = filter_quality(output.entities)
        total_rejected += rejected
        quality_ids = {e.id for e in quality}

        print(f"  Extracted {len(output.entities)} entities ({rejected} rejected), {len(output.triples)} triples")

        for ent in quality:
            if ent.id in all_entities:
                existing = all_entities[ent.id]
                if len(ent.description) > len(existing.description):
                    all_entities[ent.id] = ent
                    all_entities[ent.id].aliases = list(set(existing.aliases + ent.aliases))
                else:
                    existing.aliases = list(set(existing.aliases + ent.aliases))
            else:
                all_entities[ent.id] = ent

        for triple in output.triples:
            if triple.subject_id not in quality_ids or triple.object_id not in quality_ids:
                continue
            edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
            if edge_id not in seen_edge_ids:
                seen_edge_ids.add(edge_id)
                all_triples.append(triple)

    except Exception as e:
        print(f"  ERROR: {e}")
        if "429" in str(e) or "rate" in str(e).lower():
            print("  Rate limited, waiting 30s...")
            time.sleep(30)

    if batch_idx < len(batches) - 1:
        time.sleep(2)

# --- Summary ---
print(f"\n{'='*60}")
print(f"TOTAL: {len(all_entities)} unique entities, {len(all_triples)} new triples")
print(f"Quality gate rejected: {total_rejected} entities across all batches")

# Show target entity if specified
if ENTITY_ID and ENTITY_ID in all_entities:
    ent = all_entities[ENTITY_ID]
    print(f"\n{ent.label}:")
    print(f"  Description: {ent.description}")
    print(f"  Aliases: {ent.aliases}")

target_edges = [t for t in all_triples if SEARCH_TERM.lower() in t.subject_id or SEARCH_TERM.lower() in t.object_id] if not ENTITY_ID else [t for t in all_triples if t.subject_id == ENTITY_ID or t.object_id == ENTITY_ID]
print(f"\n\"{SEARCH_TERM}\" connections: {len(target_edges)}")
for t in target_edges[:20]:
    print(f"  {t.subject_id} --[{t.predicate}]--> {t.object_id}")
    print(f"    Evidence: {t.evidence_text[:100]}...")
if len(target_edges) > 20:
    print(f"  ... and {len(target_edges) - 20} more")

if args.dry_run:
    print("\n[DRY RUN] No changes written to Supabase.")
    sys.exit(0)

# --- Upsert ---
print(f"\n{'='*60}")
print(f"Upserting {len(all_entities)} entities and {len(all_triples)} edges to Supabase...")

print("\nUpserting nodes...")
total_ents = len(all_entities)
cx, cy = 400, 400
radius = max(200, total_ents * 30)

node_records = []
for i, ent in enumerate(all_entities.values()):
    angle = (2 * math.pi * i) / max(total_ents, 1)
    node_records.append({
        "id": ent.id,
        "label": ent.label,
        "type": ent.type.upper(),
        "description": ent.description,
        "aliases": ent.aliases,
        "position": {"x": cx + radius * math.cos(angle), "y": cy + radius * math.sin(angle)},
        "metadata": {}
    })

for i in range(0, len(node_records), 50):
    batch = node_records[i:i+50]
    sb.table("nodes").upsert(batch, on_conflict="id").execute()
    print(f"  Upserted nodes {i+1}-{min(i+50, len(node_records))}")

print("Upserting edges...")
all_node_ids_res = sb.table("nodes").select("id").execute()
valid_node_ids = {r["id"] for r in (all_node_ids_res.data or [])}
valid_node_ids.update(all_entities.keys())

edge_records = []
skipped = 0
for triple in all_triples:
    if triple.subject_id not in valid_node_ids or triple.object_id not in valid_node_ids:
        skipped += 1
        continue
    edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
    edge_records.append({
        "id": edge_id,
        "source": triple.subject_id,
        "target": triple.object_id,
        "label": triple.predicate.replace("_", " "),
        "predicate": triple.predicate,
        "evidence_text": triple.evidence_text,
        "source_filename": triple.source_filename,
        "source_page": triple.source_page,
        "confidence": triple.confidence,
        "date_mentioned": triple.date_mentioned or None,
    })
if skipped:
    print(f"  Skipped {skipped} edges with missing node references")

for i in range(0, len(edge_records), 50):
    batch = edge_records[i:i+50]
    sb.table("edges").upsert(batch, on_conflict="id").execute()
    print(f"  Upserted edges {i+1}-{min(i+50, len(edge_records))}")

print(f"\nDone! \"{SEARCH_TERM}\" extraction complete.")

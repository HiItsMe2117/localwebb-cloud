"""
Agent configuration and client initialization.
Reuses the same services as the main API: Supabase, Pinecone, Gemini, Groq.
"""

import os
import sys
import hashlib
from pathlib import Path
from dotenv import load_dotenv

# Load .env.prod from project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env.prod")

# Also add project root + api/ to path so we can import api modules
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "api"))

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "").strip()
PINECONE_API_KEY = (os.getenv("PINECONE_API_KEY") or "").strip()
PINECONE_INDEX_NAME = (os.getenv("PINECONE_INDEX") or "localwebb").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()

# ---------------------------------------------------------------------------
# Agent settings
# ---------------------------------------------------------------------------
# How long to wait between investigation cycles (seconds)
CYCLE_COOLDOWN = 30

# Max tasks to spawn from a single investigation
MAX_CHILD_TASKS_PER_CYCLE = 5

# Models
PRIMARY_MODEL = "gemini-2.5-pro"
FAST_MODEL = "gemini-2.0-flash"
EMBEDDING_MODEL = "gemini-embedding-001"

# Search settings
SEMANTIC_FETCH_K = 200
SEMANTIC_RERANK_TOP_N = 12
# How many top-scored Pinecone hits to feed into the LLM rerank pass.
# Set to 0 to disable rerank.
SEMANTIC_RERANK_SHORTLIST = 30

# Theory testing thresholds
THEORY_CONFIDENCE_COMMIT = 0.6  # auto-commit findings above this confidence

# Selective web-search grounding (hybrid with Pinecone corpus).
# Controlled invocation avoids blowing cost while fixing corpus staleness
# and adding URL-level receipts for public figures.
WEB_SEARCH_ENABLED = True
WEB_SEARCH_MODEL = "gemini-2.0-flash"  # grounding doesn't need PRIMARY_MODEL
WEB_SEARCH_MIN_HITS = 3    # trigger if corpus returns fewer than this many hits
WEB_SEARCH_MIN_SCORE = 0.55  # trigger if top corpus score is below this
WEB_SEARCH_MAX_RESULTS = 8  # max web citations to include in a single prompt

# Iterative deepening — one follow-up research round when confidence is low
# and the LLM flagged follow-up queries. Biggest depth lever; more rounds
# show rapidly diminishing returns and run up cost.
ITERATIVE_DEEPENING_MAX_ROUNDS = 1
ITERATIVE_DEEPENING_CONFIDENCE_THRESHOLD = 0.7  # only deepen if confidence < this

# Prior-investigation context injection
PRIOR_MEMORY_LIMIT = 6  # max prior-memory entries to include in a prompt

# Bigger Picture periodic re-synthesis
BIGGER_PICTURE_INTERVAL = 20  # re-synthesize every N agent cycles

# Case hierarchy limits
MAX_CASE_ENTITIES = 30       # entities per case before it needs splitting
MAX_CASE_EVIDENCE = 15       # evidence entries per case before it needs splitting
MAX_CASE_DEPTH = 3           # max nesting depth (root=0, sub=1, sub-sub=2)
MAX_SUBCASES_PER_PARENT = 6  # max children per case

# ---------------------------------------------------------------------------
# Client initialization (lazy singletons)
# ---------------------------------------------------------------------------
_supabase = None
_pinecone_index = None
_genai_client = None


def get_supabase():
    global _supabase
    if _supabase is not None:
        return _supabase
    from supabase import create_client
    if SUPABASE_URL and SUPABASE_KEY:
        _supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("[config] Supabase client initialized")
    else:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
    return _supabase


def get_pinecone():
    global _pinecone_index
    if _pinecone_index is not None:
        return _pinecone_index
    from pinecone import Pinecone
    if PINECONE_API_KEY and PINECONE_INDEX_NAME:
        pc = Pinecone(api_key=PINECONE_API_KEY)
        _pinecone_index = pc.Index(PINECONE_INDEX_NAME)
        print(f"[config] Pinecone index '{PINECONE_INDEX_NAME}' initialized")
    else:
        raise RuntimeError("PINECONE_API_KEY and PINECONE_INDEX are required")
    return _pinecone_index


def get_genai():
    global _genai_client
    if _genai_client is not None:
        return _genai_client
    from google import genai
    if GOOGLE_API_KEY:
        _genai_client = genai.Client(api_key=GOOGLE_API_KEY)
        print("[config] Gemini client initialized")
    else:
        raise RuntimeError("GOOGLE_API_KEY is required")
    return _genai_client


def content_hash(text) -> str:
    """Deterministic hash for dedup in agent_memory."""
    if not isinstance(text, str):
        text = str(text)
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:16]

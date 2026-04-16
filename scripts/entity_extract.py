"""
Gemini-based entity extraction for document metadata.
Shared by reindex.py (inline extraction) and upgrade_metadata.py (backfill).
"""

import time
from typing import Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Pydantic schema for structured output
# ---------------------------------------------------------------------------

class DocumentMetadata(BaseModel):
    """Structured metadata extracted from a document."""
    people: list[str] = Field(
        default_factory=list,
        description="Person names mentioned, normalized to Title Case"
    )
    organizations: list[str] = Field(
        default_factory=list,
        description="Organizations including govt agencies, courts, companies, foundations"
    )
    dates: list[str] = Field(
        default_factory=list,
        description="Dates in ISO YYYY-MM-DD format (or YYYY-MM / YYYY for partial)"
    )
    locations: list[str] = Field(
        default_factory=list,
        description="Places, addresses, facilities, cities, states, countries"
    )
    doc_type: str = Field(
        default="other",
        description=(
            "One of: flight_log, deposition, financial_record, correspondence, "
            "legal_filing, report, law_enforcement, court_order, subpoena, "
            "interview_transcript, photograph_description, other"
        )
    )


# ---------------------------------------------------------------------------
# Extraction prompt
# ---------------------------------------------------------------------------

METADATA_EXTRACTION_PROMPT = """You are an investigative intelligence analyst. Extract structured metadata from this document.

RULES:
1. PEOPLE: Extract ALL person names exactly as they appear. Include:
   - Names in ALL CAPS (e.g., "JOHN DOE" -> "John Doe")
   - Names with initials (e.g., "J. Doe", "John D. Smith Jr.")
   - Hyphenated names (e.g., "Mary Smith-Jones")
   - Names with titles (e.g., "Dr. Smith", "Agent Jones") — include the title
   - Single names if they clearly refer to a specific person
   - Normalize ALL names to Title Case for consistency
   - Do NOT include generic legal roles like "THE WITNESS" or "THE DEFENDANT"
2. ORGANIZATIONS: Extract ALL organizations including:
   - Government agencies (FBI, DOJ, IRS, SEC, USAO, etc.)
   - Courts (Southern District of New York, Palm Beach County Court, etc.)
   - Law firms, companies, foundations, trusts, banks
   - Schools, hospitals, institutions
   - International organizations
3. DATES: Convert all dates to ISO format (YYYY-MM-DD). Use YYYY-MM for month-only, YYYY for year-only.
4. LOCATIONS: Extract places, addresses, islands, buildings, facilities, cities, states, countries.
5. DOC_TYPE: Classify as one of: flight_log, deposition, financial_record, correspondence, legal_filing, report, law_enforcement, court_order, subpoena, interview_transcript, photograph_description, other

DOCUMENT ({filename}):
{text}"""


# ---------------------------------------------------------------------------
# Rate limiter for Gemini free tier
# ---------------------------------------------------------------------------

class RateLimiter:
    """Tracks Gemini free-tier limits: 15 RPM, 1500 RPD, 1M tokens/day."""

    def __init__(self, rpm=14, rpd=1450, tokens_per_day=950_000, base_delay=4.5):
        self.rpm = rpm
        self.rpd = rpd
        self.tokens_per_day = tokens_per_day
        self.base_delay = base_delay
        self.calls_today = 0
        self.tokens_today = 0
        self.last_call_time = 0.0
        self.calls_this_minute: list[float] = []

    def wait_if_needed(self):
        """Block until it's safe to make the next call."""
        now = time.time()
        # Clean old minute-window entries
        self.calls_this_minute = [t for t in self.calls_this_minute if now - t < 60]
        if len(self.calls_this_minute) >= self.rpm:
            sleep_time = 60 - (now - self.calls_this_minute[0]) + 1
            time.sleep(max(sleep_time, 1))
        # Enforce minimum delay
        elapsed = now - self.last_call_time
        if elapsed < self.base_delay:
            time.sleep(self.base_delay - elapsed)

    def record_call(self, est_tokens=0):
        now = time.time()
        self.calls_this_minute.append(now)
        self.last_call_time = now
        self.calls_today += 1
        self.tokens_today += est_tokens

    def can_continue(self):
        return self.calls_today < self.rpd and self.tokens_today < self.tokens_per_day

    def budget_status(self):
        return {
            "calls_today": self.calls_today,
            "calls_remaining": self.rpd - self.calls_today,
            "tokens_today": self.tokens_today,
            "tokens_remaining": self.tokens_per_day - self.tokens_today,
        }


# ---------------------------------------------------------------------------
# Core extraction function
# ---------------------------------------------------------------------------

def extract_metadata_gemini(
    genai_client,
    types_module,
    text: str,
    filename: str,
    rate_limiter: Optional[RateLimiter] = None,
    max_retries: int = 2,
) -> Optional[dict]:
    """
    Extract structured metadata from document text using Gemini 2.0 Flash.

    Args:
        genai_client: google.genai.Client instance
        types_module: google.genai.types module
        text: Full document text (concatenated chunks)
        filename: Document filename
        rate_limiter: Optional RateLimiter instance
        max_retries: Retry count on failure

    Returns:
        dict with keys: people, organizations, dates, locations, doc_type,
        metadata_version — or None on failure.
    """
    # Truncate to fit context (leave room for prompt template)
    max_chars = 100_000  # ~25K tokens, well within 1M context
    if len(text) > max_chars:
        text = text[:max_chars] + "\n...[truncated]"

    prompt = METADATA_EXTRACTION_PROMPT.format(filename=filename, text=text)
    est_tokens = len(prompt) // 4  # rough estimate

    for attempt in range(max_retries + 1):
        try:
            if rate_limiter:
                rate_limiter.wait_if_needed()

            res = genai_client.models.generate_content(
                model="gemini-2.0-flash",
                contents=prompt,
                config=types_module.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=DocumentMetadata,
                )
            )

            if rate_limiter:
                rate_limiter.record_call(est_tokens)

            parsed = res.parsed
            return {
                "people": parsed.people[:30],
                "organizations": parsed.organizations[:30],
                "dates": parsed.dates[:20],
                "locations": parsed.locations[:20],
                "doc_type": parsed.doc_type,
                "metadata_version": 2,
            }

        except Exception as e:
            if rate_limiter:
                rate_limiter.record_call(est_tokens)
            error_str = str(e).lower()
            if "429" in error_str or "quota" in error_str or "rate" in error_str:
                wait = min(30 * (2 ** attempt), 120)
                print(f"    Rate limited, backing off {wait}s: {e}")
                time.sleep(wait)
            elif attempt < max_retries:
                wait = (attempt + 1) * 5
                print(f"    Extraction retry {attempt+1}/{max_retries} (waiting {wait}s): {e}")
                time.sleep(wait)
            else:
                print(f"    Extraction FAILED after {max_retries+1} attempts: {e}")
                return None

    return None

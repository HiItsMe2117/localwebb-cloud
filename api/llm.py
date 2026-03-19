"""
Shared LLM helper with Groq fallback on Gemini rate limits.

Usage:
    from api.llm import generate, generate_stream

    # Non-streaming (returns object with .text and optionally .parsed)
    res = generate(genai_client, model="gemini-2.0-flash", contents="...", config=...)

    # Streaming (yields chunks with .text)
    for chunk in generate_stream(genai_client, model="gemini-2.0-flash", contents="..."):
        print(chunk.text)
"""

import os
import json

# ---------------------------------------------------------------------------
# Groq client (lazy — only created if GROQ_API_KEY is set)
# ---------------------------------------------------------------------------
_groq_client = None

def _get_groq_client():
    global _groq_client
    if _groq_client is not None:
        return _groq_client
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        from groq import Groq
        _groq_client = Groq(api_key=api_key)
        print("LLM: Groq fallback client initialized")
        return _groq_client
    except Exception as e:
        print(f"LLM: Failed to initialize Groq client: {e}")
        return None

# ---------------------------------------------------------------------------
# Model mapping
# ---------------------------------------------------------------------------
_MODEL_MAP = {
    "gemini-2.5-pro": "llama-3.3-70b-versatile",
    "gemini-2.0-flash": "llama-3.3-70b-versatile",
}

# ---------------------------------------------------------------------------
# Rate-limit detection
# ---------------------------------------------------------------------------
def _is_rate_limit(exc):
    """Return True if the exception looks like a Gemini 429 / RESOURCE_EXHAUSTED."""
    msg = f"{type(exc).__name__}: {exc}".lower()
    return any(kw in msg for kw in ("429", "resource_exhausted", "rate limit", "quota"))

# ---------------------------------------------------------------------------
# Gemini contents → OpenAI-style messages
# ---------------------------------------------------------------------------
def _to_messages(contents):
    """Convert Gemini-style `contents` to a list of OpenAI chat messages."""
    if isinstance(contents, str):
        return [{"role": "user", "content": contents}]
    if isinstance(contents, list):
        parts = []
        for item in contents:
            if isinstance(item, str):
                parts.append(item)
            elif hasattr(item, "text") and item.text:
                parts.append(item.text)
            else:
                # Non-text Part (bytes, images) — Groq can't handle these
                raise TypeError("Groq fallback does not support multimodal content")
        return [{"role": "user", "content": "\n\n".join(parts)}]
    return [{"role": "user", "content": str(contents)}]

# ---------------------------------------------------------------------------
# Response wrappers (mimic Gemini response shape)
# ---------------------------------------------------------------------------
class _GroqResponse:
    """Minimal stand-in for a Gemini GenerateContentResponse."""
    def __init__(self, text, parsed=None, usage_metadata=None):
        self.text = text
        self.parsed = parsed
        self.usage_metadata = usage_metadata


class _GroqChunk:
    """Minimal stand-in for a Gemini streaming chunk."""
    def __init__(self, text, usage_metadata=None):
        self.text = text
        self.usage_metadata = usage_metadata

# ---------------------------------------------------------------------------
# Groq generation helpers
# ---------------------------------------------------------------------------
def _groq_generate(model, contents, config):
    groq = _get_groq_client()
    if groq is None:
        raise RuntimeError("Groq fallback unavailable (GROQ_API_KEY not set)")

    groq_model = _MODEL_MAP.get(model, "llama-3.3-70b-versatile")
    messages = _to_messages(contents)
    kwargs = {"model": groq_model, "messages": messages}

    # JSON mode
    schema_cls = None
    if config:
        if getattr(config, "response_mime_type", None) == "application/json":
            kwargs["response_format"] = {"type": "json_object"}
        schema_cls = getattr(config, "response_schema", None)

    completion = groq.chat.completions.create(**kwargs)
    text = completion.choices[0].message.content or ""

    # Usage metadata (mimic Gemini)
    usage = completion.usage
    usage_metadata = None
    if usage:
        usage_metadata = type('Usage', (), {
            'prompt_token_count': usage.prompt_tokens,
            'candidates_token_count': usage.completion_tokens,
            'total_token_count': usage.total_tokens
        })

    # Attempt Pydantic parsing when a response_schema was requested
    parsed = None
    if schema_cls is not None:
        try:
            data = json.loads(text)
            if hasattr(schema_cls, "model_validate"):
                parsed = schema_cls.model_validate(data)
            else:
                parsed = schema_cls(**data)
        except Exception as parse_err:
            print(f"LLM: Groq response schema parse failed: {parse_err}")

    return _GroqResponse(text=text, parsed=parsed, usage_metadata=usage_metadata)


def _groq_generate_stream(model, contents, config):
    groq = _get_groq_client()
    if groq is None:
        raise RuntimeError("Groq fallback unavailable (GROQ_API_KEY not set)")

    groq_model = _MODEL_MAP.get(model, "llama-3.3-70b-versatile")
    messages = _to_messages(contents)
    kwargs = {"model": groq_model, "messages": messages, "stream": True}

    # Note: Usage in streaming is usually only in the last chunk for OpenAI/Groq
    stream = groq.chat.completions.create(**kwargs)
    for chunk in stream:
        text = chunk.choices[0].delta.content or ""
        # Groq/OpenAI doesn't always send usage in the stream chunks easily unless specified
        if text:
            yield _GroqChunk(text=text)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def generate(genai_client, model, contents, config=None):
    """
    Non-streaming generation. Tries Gemini first; on 429 / RESOURCE_EXHAUSTED
    falls back to Groq.  Returns an object with .text (and optionally .parsed).
    """
    try:
        return genai_client.models.generate_content(
            model=model, contents=contents, config=config,
        )
    except Exception as e:
        if not _is_rate_limit(e) or _get_groq_client() is None:
            raise
        print(f"LLM: Gemini rate-limited ({model}), falling back to Groq")
        return _groq_generate(model, contents, config)


def generate_stream(genai_client, model, contents, config=None):
    """
    Streaming generation. Tries Gemini first; on 429 / RESOURCE_EXHAUSTED
    falls back to Groq streaming.  Yields chunks with .text attribute.
    """
    try:
        stream = genai_client.models.generate_content_stream(
            model=model, contents=contents, config=config,
        )
        for chunk in stream:
            yield chunk
    except Exception as e:
        if not _is_rate_limit(e) or _get_groq_client() is None:
            raise
        print(f"LLM: Gemini rate-limited ({model}), falling back to Groq streaming")
        yield from _groq_generate_stream(model, contents, config)

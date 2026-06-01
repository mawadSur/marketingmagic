"""
Bring-Your-Own-Key (BYO) request-scoped credential overrides.

MoneyPrinterTurbo normally reads every LLM / material API key from the global
`config.app` singleton (loaded once from config.toml at import time). That makes
true multi-tenant SaaS impossible: every render would use the same platform key.

This module adds a request-scoped override layer so each render job can carry the
customer's OWN keys. A single render task runs start-to-finish in one worker
thread, so we stash the overrides in a `ContextVar` at the top of
`task.start()` and every downstream credential read (`llm._generate_response`,
`material.get_api_key`) transparently prefers them, falling back to `config.app`
when a key was not supplied.

Design notes:
- Keys are NEVER persisted here. The dict lives only for the duration of one task
  and is reset in a `finally` so a reused thread can't leak one tenant's keys into
  the next task.
- The override dict is keyed by MoneyPrinterTurbo's native config names
  (e.g. "openai_api_key", "pexels_api_keys"). `build_overrides()` maps the generic
  fields the caller sends (llm_provider / llm_api_key / ...) onto those names.
- TTS provider keys are intentionally NOT wired here yet (v1 uses free Edge-TTS).
  The schema accepts tts_provider/tts_api_key for forward-compat but they are
  ignored until v2.
"""

import contextvars
from typing import Any, Dict, Optional

from app.config import config

# Per-request credential overrides. Default None => "no BYO, use global config".
_overrides: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "mpt_byo_overrides", default=None
)

# Values that mean "not provided" and should fall through to global config.
_EMPTY = (None, "", [], {})

# Per-request fields that carry customer secrets. These must be masked before any
# params object is logged or persisted to disk (script.json), otherwise a BYO
# customer's API keys leak into server logs / the task directory.
_SENSITIVE_KEYS = frozenset(
    {"llm_api_key", "pexels_api_keys", "pixabay_api_keys", "tts_api_key"}
)
_REDACTED = "***redacted***"


def redact(data: Any) -> Any:
    """Return a shallow copy of a params dict with BYO secrets masked, safe for
    logging or writing to disk. Non-dict input is returned unchanged."""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    for key in list(out.keys()):
        if key in _SENSITIVE_KEYS and out[key] not in _EMPTY:
            out[key] = _REDACTED
    return out


def scrub(text: Any) -> Any:
    """Mask the *current request's* secret values anywhere they appear in a string.

    Some upstream providers echo the API key back in their error messages (e.g.
    OpenAI's "Incorrect API key provided: sk-..."). When MPT logs that error
    verbatim, the BYO customer's key would leak into server logs. This scrubs any
    active override key value out of the text. Safe to call on every log line;
    a no-op when no BYO overrides are active or the input is not a string.
    """
    if not isinstance(text, str):
        return text
    overrides = _overrides.get()
    if not overrides:
        return text
    for key, val in overrides.items():
        if not (key.endswith("_api_key") or key.endswith("_api_keys")):
            continue
        candidates = val if isinstance(val, (list, tuple)) else [val]
        for secret in candidates:
            if isinstance(secret, str) and len(secret) >= 6 and secret in text:
                text = text.replace(secret, _REDACTED)
    return text


def set_overrides(overrides: Optional[Dict[str, Any]]) -> contextvars.Token:
    """Install per-request overrides for the current context. Returns a token to
    pass to `reset_overrides()` in a finally block."""
    return _overrides.set(overrides or None)


def reset_overrides(token: contextvars.Token) -> None:
    """Restore the previous override state (call in a finally)."""
    try:
        _overrides.reset(token)
    except (ValueError, LookupError):
        # Token from a different context (shouldn't happen in the one-thread-per-task
        # model); fall back to clearing so we never leak keys across tenants.
        _overrides.set(None)


def get_overrides() -> Optional[Dict[str, Any]]:
    return _overrides.get()


def cfg(key: str, default: Any = None) -> Any:
    """Credential/config read that prefers the current request's BYO override and
    falls back to the global `config.app` singleton. Drop-in for
    `config.app.get(key, default)`."""
    overrides = _overrides.get()
    if overrides is not None:
        value = overrides.get(key)
        if value not in _EMPTY:
            return value
    return config.app.get(key, default)


def build_overrides(params: Any) -> Optional[Dict[str, Any]]:
    """Translate the generic BYO fields on a VideoParams-like object into
    MoneyPrinterTurbo's native config keys.

    A caller sends provider-agnostic fields (llm_provider, llm_api_key,
    llm_base_url, llm_model_name, pexels_api_keys, pixabay_api_keys); MPT's LLM
    dispatcher expects per-provider names like `openai_api_key`,
    `openai_base_url`, `openai_model_name`. We fan the generic fields out onto the
    chosen provider so `cfg("openai_api_key")` resolves to the customer's key.

    Returns None when no BYO fields were supplied (=> behave exactly as before).
    """
    overrides: Dict[str, Any] = {}

    provider = getattr(params, "llm_provider", None)
    if provider:
        provider = str(provider).strip().lower()
        overrides["llm_provider"] = provider
        api_key = getattr(params, "llm_api_key", None)
        base_url = getattr(params, "llm_base_url", None)
        model_name = getattr(params, "llm_model_name", None)
        if api_key:
            overrides[f"{provider}_api_key"] = api_key
        if base_url:
            overrides[f"{provider}_base_url"] = base_url
        if model_name:
            overrides[f"{provider}_model_name"] = model_name

    pexels = getattr(params, "pexels_api_keys", None)
    if pexels:
        overrides["pexels_api_keys"] = pexels

    pixabay = getattr(params, "pixabay_api_keys", None)
    if pixabay:
        overrides["pixabay_api_keys"] = pixabay

    return overrides or None

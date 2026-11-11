"""
Model calls. The default backend is a local Ollama, so form answers never leave this Mac.

config.yaml  llm.backend   ollama | groq | opencode
             llm.fallback  none | the same names; used only when the main backend raises
Chat and embeddings share one HTTP seam (_post) so tests can swap the network out.
"""
from __future__ import annotations

import itertools
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from functools import lru_cache
from typing import Any, Callable

from . import config

_TIMEOUT = 120
_chat_model_cache: dict[str, str] = {}


class LLMUnavailable(RuntimeError):
    """The backend could not be reached or returned an error. Callers queue the work and retry later."""


class RateLimited(LLMUnavailable):
    """A 429 from a hosted model. retry_after is how many seconds that key should rest."""
    def __init__(self, msg: str, retry_after: float = 60):
        super().__init__(msg)
        self.retry_after = retry_after


def _post(url: str, body: dict, headers: dict | None = None, timeout: int = _TIMEOUT) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "apply-factory/0.6", **(headers or {})},  # Groq refuses the default Python agent
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                wait = float(e.headers.get("retry-after") or 60)
            except ValueError:
                wait = 60
            raise RateLimited(f"{url}: rate limited", min(max(wait, 5), 3600)) from e
        raise LLMUnavailable(f"{url}: HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
        raise LLMUnavailable(f"{url}: {e}") from e


def _get(url: str, timeout: int = 5) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
        raise LLMUnavailable(f"{url}: {e}") from e


# The network seams. Tests replace these two names.
post: Callable[..., dict] = _post
get: Callable[..., dict] = _get


# Every chat call asks for this context size. Ollama reloads the model whenever the size changes between calls, which costs
# 15 to 20 seconds each time, so the size is fixed rather than chosen per call.
CTX = 8192


def _cfg() -> dict:
    return config.load()["llm"]


def ollama_models() -> list[str]:
    return [m["name"] for m in get(f"{_cfg()['host']}/api/tags").get("models", [])]


def chat_model() -> str:
    """The configured chat model, or the first installed non-embedding model when it is not pulled yet."""
    wanted = _cfg()["model"]
    if wanted in _chat_model_cache:
        return _chat_model_cache[wanted]
    installed = ollama_models()
    if wanted in installed or f"{wanted}:latest" in installed:
        pick = wanted
    else:
        chat = [m for m in installed if "embed" not in m]
        if not chat:
            raise LLMUnavailable(f"ollama has no chat model; run: ollama pull {wanted}")
        pick = chat[0]
    _chat_model_cache[wanted] = pick
    return pick


def _ollama(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = CTX, timeout: int = _TIMEOUT, num_predict: int = 0) -> str:
    body: dict[str, Any] = {
        "model": chat_model(), "stream": False, "think": False, "keep_alive": _cfg().get("keep_alive", "30m"),
        "options": {"temperature": temperature, "num_ctx": num_ctx, **({"num_predict": num_predict} if num_predict else {})},
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}],
    }
    if json_mode:
        body["format"] = "json"
    out = post(f"{_cfg()['host']}/api/chat", body, timeout=timeout)
    return (out.get("message") or {}).get("content", "").strip()


def _groq(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = 0, timeout: int = _TIMEOUT, num_predict: int = 0) -> str:
    key = config.env("GROQ_API_KEY")
    if not key:
        raise LLMUnavailable("GROQ_API_KEY is not set")
    body: dict[str, Any] = {
        "model": "llama-3.3-70b-versatile", "temperature": temperature,
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}],
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    out = post("https://api.groq.com/openai/v1/chat/completions", body, {"Authorization": f"Bearer {key}"}, timeout=timeout)
    return out["choices"][0]["message"]["content"].strip()


# Hosted models for the long answers (see llm.cloud in config.yaml). Every key in career-ops' .env is used in turn; a key that
# answers 429 rests for the time the server asks, and when none is free the call falls through to the local model.
_REST: dict[str, float] = {}
_TURN = itertools.count()
_LOCK = threading.Lock()
USAGE = {"cloud": 0, "local_after_cloud": 0, "rate_limited": 0}
# Key number n is GROQ_API_KEY_n (GROQ_API_KEY alone is number 1) and GEMINI_API_KEY_n. llm.cloud.keys picks which numbers the extension may use.
_PROVIDERS = {
    "groq": ("https://api.groq.com/openai/v1/chat/completions", {1: "GROQ_API_KEY", **{i: f"GROQ_API_KEY_{i}" for i in range(2, 10)}}),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {i: f"GEMINI_API_KEY_{i}" for i in range(1, 11)}),
}


@lru_cache(maxsize=1)
def _pool() -> tuple[tuple[str, str], ...]:
    """(provider, key) for every hosted key the extension may use, in the order the providers are tried. The scanners share the same
    .env, so llm.cloud.keys keeps the extension to its own numbers and leaves the rest of the daily limits to them."""
    found = []
    allowed = (_cfg().get("cloud") or {}).get("keys") or {}
    for provider, (_, names) in _PROVIDERS.items():
        wanted = allowed.get(provider)
        keys = list(dict.fromkeys(k for n, name in names.items() if not wanted or n in wanted for k in [config.env(name)] if k))
        found += [(provider, k) for k in keys]
    return tuple(found)


def _cloud(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = 0, timeout: int = 60, num_predict: int = 0) -> str:
    cfg = _cfg().get("cloud") or {}
    if not cfg.get("enabled"):
        raise LLMUnavailable("hosted models are off")
    now = time.time()
    with _LOCK:
        turn = next(_TURN)
    order = []
    for provider in cfg.get("providers", ["groq", "gemini"]):
        keys = [k for p, k in _pool() if p == provider]
        wanted = cfg.get(f"{provider}_model") or ("openai/gpt-oss-120b" if provider == "groq" else "gemini-3.5-flash")
        models = [wanted] if isinstance(wanted, str) else list(wanted)
        # every model of a provider has its own limit, so a limited key still serves the next model in the list
        order += [(provider, keys[(turn + i) % len(keys)], m) for m in models for i in range(len(keys))]
    for provider, key, model in order:
        kid = f"{provider}:{model}:{key[-6:]}"
        if _REST.get(kid, 0) > now:
            continue
        body: dict[str, Any] = {
            "model": model, "temperature": temperature,
            "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}],
            "reasoning_effort": "low" if provider == "groq" else "none",
        }
        if num_predict:
            body["max_completion_tokens" if provider == "groq" else "max_tokens"] = num_predict + (500 if provider == "groq" else 0)
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            out = post(_PROVIDERS[provider][0], body, {"Authorization": f"Bearer {key}"}, timeout=timeout)
            text = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        except RateLimited as e:
            _REST[kid] = time.time() + e.retry_after
            USAGE["rate_limited"] += 1
            continue
        except LLMUnavailable:
            _REST[kid] = time.time() + 30  # a failing key sits out half a minute
            continue
        if text.strip():
            USAGE["cloud"] += 1
            return text.strip()
    raise LLMUnavailable("no hosted key was available")


def _opencode(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = 0, timeout: int = _TIMEOUT, num_predict: int = 0) -> str:
    full = f"{system}\n\n{prompt}" if system else prompt
    try:
        r = subprocess.run(["opencode", "run", "--stdin"], input=full, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise LLMUnavailable(f"opencode: {e}") from e
    if r.returncode != 0:
        raise LLMUnavailable(f"opencode failed: {r.stderr[:200]}")
    return r.stdout.strip()


BACKENDS: dict[str, Callable[..., str]] = {"ollama": _ollama, "groq": _groq, "opencode": _opencode, "cloud": _cloud}


def call(prompt: str, *, system: str | None = None, temperature: float | None = None, json_mode: bool = False,
         num_ctx: int = CTX, timeout: int = _TIMEOUT, num_predict: int = 0, tier: str = "local") -> str:
    """tier="cloud" tries the hosted models first (long answers) and falls back to the local model; the default stays local."""
    cfg = _cfg()
    temp = cfg["temperature"] if temperature is None else temperature
    order = (["cloud"] if tier == "cloud" and (cfg.get("cloud") or {}).get("enabled") else []) + [cfg["backend"]] + ([cfg["fallback"]] if cfg.get("fallback") not in (None, "none", cfg["backend"]) else [])
    last: Exception | None = None
    for name in order:
        if name not in BACKENDS:
            raise ValueError(f"Unknown llm backend: {name}")
        try:
            if name == "cloud":
                return _cloud(prompt, system, temp, json_mode, num_ctx, min(timeout, 90), num_predict)
            if name != "cloud" and order[0] == "cloud":
                USAGE["local_after_cloud"] += 1
            return BACKENDS[name](prompt, system, temp, json_mode, num_ctx, timeout, num_predict)
        except LLMUnavailable as e:
            last = e
    raise LLMUnavailable(str(last))


def call_json(prompt: str, *, system: str | None = None, temperature: float | None = None, num_ctx: int = CTX,
              timeout: int = _TIMEOUT, num_predict: int = 0, tier: str = "local") -> Any:
    raw = call(prompt, system=system, temperature=temperature, json_mode=True, num_ctx=num_ctx, timeout=timeout, num_predict=num_predict, tier=tier)
    clean = raw.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM did not return valid JSON:\n{raw[:300]}") from e


def embed(texts: list[str]) -> list[list[float]]:
    """One vector per text from the local embedding model. Raises LLMUnavailable when ollama is down."""
    cfg = _cfg()
    out = post(f"{cfg['host']}/api/embed", {"model": cfg["embed_model"], "input": texts, "keep_alive": cfg.get("keep_alive", "30m")})
    vecs = out.get("embeddings")
    if not vecs or len(vecs) != len(texts):
        raise LLMUnavailable("embedding response had the wrong shape")
    return vecs


def status() -> dict:
    """For the side panel: is the local model reachable and which models are present."""
    cfg = _cfg()
    try:
        installed = ollama_models()
    except LLMUnavailable as e:
        return {"ok": False, "backend": cfg["backend"], "error": str(e)}
    embed_ok = any(m.startswith(cfg["embed_model"]) for m in installed)
    chat = [m for m in installed if "embed" not in m]
    return {"ok": bool(chat), "backend": cfg["backend"], "cloud": {"enabled": bool((cfg.get("cloud") or {}).get("enabled")), "keys": len(_pool()), **USAGE}, "chat_model": chat_model() if chat else None,
            "embeddings": embed_ok, "installed": installed}

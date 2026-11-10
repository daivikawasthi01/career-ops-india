"""
Model calls. The default backend is a local Ollama, so form answers never leave this Mac.

config.yaml  llm.backend   ollama | groq | opencode
             llm.fallback  none | the same names; used only when the main backend raises
Chat and embeddings share one HTTP seam (_post) so tests can swap the network out.
"""
from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from typing import Any, Callable

from . import config

_TIMEOUT = 120
_chat_model_cache: dict[str, str] = {}


class LLMUnavailable(RuntimeError):
    """The backend could not be reached or returned an error. Callers queue the work and retry later."""


def _post(url: str, body: dict, headers: dict | None = None, timeout: int = _TIMEOUT) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
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


def _opencode(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = 0, timeout: int = _TIMEOUT, num_predict: int = 0) -> str:
    full = f"{system}\n\n{prompt}" if system else prompt
    try:
        r = subprocess.run(["opencode", "run", "--stdin"], input=full, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise LLMUnavailable(f"opencode: {e}") from e
    if r.returncode != 0:
        raise LLMUnavailable(f"opencode failed: {r.stderr[:200]}")
    return r.stdout.strip()


BACKENDS: dict[str, Callable[..., str]] = {"ollama": _ollama, "groq": _groq, "opencode": _opencode}


def call(prompt: str, *, system: str | None = None, temperature: float | None = None, json_mode: bool = False,
         num_ctx: int = CTX, timeout: int = _TIMEOUT, num_predict: int = 0) -> str:
    cfg = _cfg()
    temp = cfg["temperature"] if temperature is None else temperature
    order = [cfg["backend"]] + ([cfg["fallback"]] if cfg.get("fallback") not in (None, "none", cfg["backend"]) else [])
    last: Exception | None = None
    for name in order:
        if name not in BACKENDS:
            raise ValueError(f"Unknown llm backend: {name}")
        try:
            return BACKENDS[name](prompt, system, temp, json_mode, num_ctx, timeout, num_predict)
        except LLMUnavailable as e:
            last = e
    raise LLMUnavailable(str(last))


def call_json(prompt: str, *, system: str | None = None, temperature: float | None = None, num_ctx: int = CTX,
              timeout: int = _TIMEOUT, num_predict: int = 0) -> Any:
    raw = call(prompt, system=system, temperature=temperature, json_mode=True, num_ctx=num_ctx, timeout=timeout, num_predict=num_predict)
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
    return {"ok": bool(chat), "backend": cfg["backend"], "chat_model": chat_model() if chat else None,
            "embeddings": embed_ok, "installed": installed}

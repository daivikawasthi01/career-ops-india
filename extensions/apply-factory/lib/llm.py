"""
Model calls. Nothing runs on this Mac: a call goes to the hosted models first (Groq, then Gemini, rotating the keys in career-ops' .env)
and, when none of them can answer in time, to `claude -p` on your Claude plan.

config.yaml  llm.cloud    hosted models: providers, models, which key numbers, time budget
             llm.backend  the fallback, "claude"
Chat goes through two seams so tests can swap the outside world out: post (HTTP) and run_claude (the claude command).
There is no embedding model any more: embed() raises LLMUnavailable and callers match questions by wording instead.
"""
from __future__ import annotations

import itertools
import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from . import config

_TIMEOUT = 120


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


def _run_claude(args: list[str], stdin: str, timeout: float, cwd: Path) -> tuple[int, str]:
    r = subprocess.run(["claude", *args], input=stdin, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    return r.returncode, r.stdout


# The outside-world seams. Tests replace these names.
post: Callable[..., dict] = _post
run_claude: Callable[..., tuple[int, str]] = _run_claude


def _cfg() -> dict:
    return config.load()["llm"]


# Hosted models (see llm.cloud in config.yaml). The keys in career-ops' .env are used in turn; a key that answers 429 rests for the
# time the server asks, and when none is free the call falls through to claude -p.
_REST: dict[str, float] = {}
_TURN = itertools.count()
_LOCK = threading.Lock()
USAGE = {"cloud": 0, "claude": 0, "rate_limited": 0}
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


def _log(line: str) -> None:
    """Hosted-call timing for the server log: which model answered, how long it took, which keys were limited. Never the keys."""
    print(f"[llm] {line}", flush=True)


def _models(cfg: dict, provider: str) -> list[str]:
    wanted = cfg.get(f"{provider}_model") or ("openai/gpt-oss-120b" if provider == "groq" else "gemini-3.5-flash")
    return [wanted] if isinstance(wanted, str) else list(wanted)


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
        models = _models(cfg, provider)
        # every model of a provider has its own limit, so a limited key still serves the next model in the list
        order += [(provider, keys[(turn + i) % len(keys)], m) for m in models for i in range(len(keys))]
    # A hosted call gets a fixed budget (llm.cloud.budget_seconds) across all keys, and each attempt a share of it, so a provider that
    # hangs costs seconds, not minutes, before claude -p takes over. A key that times out rests for two minutes.
    budget = float(cfg.get("budget_seconds", 50))
    deadline = now + budget
    for provider, key, model in order:
        kid = f"{provider}:{model}:{key[-6:]}"
        if _REST.get(kid, 0) > now:
            continue
        left = deadline - time.time()
        if left < 3:
            break
        attempt = min(timeout, left, float(cfg.get("attempt_seconds", 35)))
        body: dict[str, Any] = {
            "model": model, "temperature": temperature,
            "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}],
            "reasoning_effort": "low" if provider == "groq" else "none",
        }
        if num_predict:
            body["max_completion_tokens" if provider == "groq" else "max_tokens"] = num_predict + (500 if provider == "groq" else 0)
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        started = time.time()
        try:
            out = post(_PROVIDERS[provider][0], body, {"Authorization": f"Bearer {key}"}, timeout=attempt)
            text = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        except RateLimited as e:
            _REST[kid] = time.time() + e.retry_after
            USAGE["rate_limited"] += 1
            _log(f"{provider}/{model} key ...{key[-4:]} rate limited, rests {e.retry_after:.0f}s ({time.time() - started:.1f}s)")
            continue
        except LLMUnavailable as e:
            slow = "timed out" in str(e)
            _REST[kid] = time.time() + (120 if slow else 30)  # a slow key sits out two minutes, a failing one half a minute
            _log(f"{provider}/{model} key ...{key[-4:]} failed: {str(e)[-60:]} ({time.time() - started:.1f}s)")
            continue
        if text.strip():
            USAGE["cloud"] += 1
            _log(f"{provider}/{model} answered in {time.time() - started:.1f}s ({len(prompt) // 4} tokens in, {len(text) // 4} out)")
            return text.strip()
    raise LLMUnavailable("no hosted key was available")


# ---- claude -p: the fallback, on your Claude plan ----
_CLAUDE_SLOTS = threading.Semaphore(2)  # the plan is shared with you: never more than two of these at once
_CLAUDE_REST = [0.0]                    # after a plan limit, claude -p rests for an hour


def _claude(prompt: str, system: str | None, temperature: float, json_mode: bool, num_ctx: int = 0, timeout: float = 90, num_predict: int = 0) -> str:
    if shutil.which("claude") is None:
        raise LLMUnavailable("claude is not installed")
    if time.time() < _CLAUDE_REST[0]:
        raise LLMUnavailable("claude -p is resting after a plan limit")
    cfg = _cfg().get("claude") or {}
    model = cfg.get("model", "haiku")  # haiku only
    sys_text = (system or "You are a careful writing assistant.") + ("\nReply with one JSON object and nothing else." if json_mode else "")
    args = ["-p", "--output-format", "json", "--model", model, "--tools", "", "--no-session-persistence", "--disable-slash-commands",
            "--setting-sources", "", "--system-prompt", sys_text]
    cwd = Path(tempfile.gettempdir()) / "apply-factory-claude"  # an empty directory: no project instructions get loaded
    cwd.mkdir(exist_ok=True)
    started = time.time()
    with _CLAUDE_SLOTS:
        try:
            code, out = run_claude(args, prompt, timeout, cwd)
        except subprocess.TimeoutExpired as e:
            raise LLMUnavailable("claude -p timed out") from e
        except OSError as e:
            raise LLMUnavailable(f"claude -p: {e}") from e
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise LLMUnavailable("claude -p gave no JSON") from e
    text = str(data.get("result") or "")
    if data.get("is_error") or code:
        if re.search(r"limit|usage|quota|reset", text, re.I):
            _CLAUDE_REST[0] = time.time() + 3600
        raise LLMUnavailable(f"claude -p error: {text[:80]}")
    USAGE["claude"] += 1
    _log(f"claude/{model} answered in {time.time() - started:.1f}s")
    return text.strip()


def _search_groq(prompt: str, system: str | None, timeout: float) -> dict:
    """gpt-oss with Groq's browser_search tool: it searches and opens pages itself. One query costs about 17k tokens, so the light model
    goes first (each model has its own daily allowance). The sources are the pages the tool really returned."""
    cfg = _cfg().get("cloud") or {}
    keys = [k for p, k in _pool() if p == "groq"]
    if not keys:
        raise LLMUnavailable("no Groq key")
    with _LOCK:
        turn = next(_TURN)
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    deadline = time.time() + float(cfg.get("search_budget_seconds", 75))
    for model in cfg.get("search_models", ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]):
        for i in range(len(keys)):
            key = keys[(turn + i) % len(keys)]
            kid = f"search:{model}:{key[-6:]}"
            left = deadline - time.time()
            if _REST.get(kid, 0) > time.time():
                continue
            if left < 5:
                raise LLMUnavailable("web search ran out of time")
            started = time.time()
            try:
                out = post(_PROVIDERS["groq"][0], {"model": model, "temperature": 0.1, "messages": messages,
                                                    "tools": [{"type": "browser_search"}], "reasoning_effort": "low"},
                           {"Authorization": f"Bearer {key}"}, timeout=min(timeout, left))
            except RateLimited as e:
                _REST[kid] = time.time() + e.retry_after
                _log(f"search {model} key ...{key[-4:]} rate limited ({time.time() - started:.1f}s)")
                continue
            except LLMUnavailable as e:
                _REST[kid] = time.time() + (120 if "timed out" in str(e) else 30)
                _log(f"search {model} key ...{key[-4:]} failed: {str(e)[-50:]} ({time.time() - started:.1f}s)")
                continue
            msg = (out.get("choices") or [{}])[0].get("message") or {}
            seen: dict[str, str] = {}
            for tool in msg.get("executed_tools") or []:
                if tool.get("type") != "browser_search":
                    continue  # browser.open results are page bodies; the search hits are the pages a claim can be checked against
                for r in (tool.get("search_results") or {}).get("results") or []:
                    if r.get("url") and r["url"] not in seen:
                        seen[r["url"]] = r.get("title", "")
            text = re.sub(r"【[^】]*】", "", msg.get("content") or "").strip()  # drop the tool's citation marks
            if text:
                _log(f"search {model} answered in {time.time() - started:.1f}s, {len(seen)} sources")
                return {"text": text, "sources": [{"title": t, "uri": u} for u, t in seen.items()]}
    raise LLMUnavailable("no Groq key could run the web search")


def web_search(prompt: str, *, system: str | None = None, timeout: float = 60) -> dict:
    """Answer from a live web search: {"text", "sources": [{"title", "uri"}]}. Groq's browser search first, then Gemini's Google
    grounding. The sources are what the search really returned, so a claim can be checked against them."""
    errors = []
    for name, run in (("groq", _search_groq), ("gemini", _search_gemini), ("claude", _search_claude)):
        if name not in ((_cfg().get("cloud") or {}).get("search_providers") or ["groq", "gemini", "claude"]):
            continue
        try:
            return run(prompt, system, timeout)
        except LLMUnavailable as e:
            errors.append(f"{name}: {e}")
    raise LLMUnavailable("web search unavailable (" + "; ".join(errors) + ")")


def _search_claude(prompt: str, system: str | None, timeout: float) -> dict:
    """Last resort: claude -p (haiku only) with just the WebSearch tool. The stream carries the links each search returned, so the
    sources are real results here too. Uses the plan, so it only runs when Groq and Gemini could not answer."""
    if shutil.which("claude") is None:
        raise LLMUnavailable("claude is not installed")
    if time.time() < _CLAUDE_REST[0]:
        raise LLMUnavailable("claude -p is resting after a plan limit")
    model = (_cfg().get("claude") or {}).get("model", "haiku")  # haiku only
    args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "WebSearch", "--allowedTools", "WebSearch",
            "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "",
            "--system-prompt", (system or "You are a careful research assistant.") + "\nUse web search. Answer briefly and only from what you found."]
    cwd = Path(tempfile.gettempdir()) / "apply-factory-claude"
    cwd.mkdir(exist_ok=True)
    started = time.time()
    with _CLAUDE_SLOTS:
        try:
            code, out = run_claude(args, prompt, max(timeout, 90), cwd)
        except subprocess.TimeoutExpired as e:
            raise LLMUnavailable("claude -p search timed out") from e
        except OSError as e:
            raise LLMUnavailable(f"claude -p: {e}") from e
    seen: dict[str, str] = {}
    text, failed = "", False
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "user":
            for res in (ev.get("tool_use_result") or {}).get("results") or []:
                for hit in res.get("content") or [] if isinstance(res, dict) else []:
                    if isinstance(hit, dict) and hit.get("url") and hit["url"] not in seen:
                        seen[hit["url"]] = hit.get("title", "")
        elif ev.get("type") == "result":
            text, failed = str(ev.get("result") or ""), bool(ev.get("is_error"))
    if failed or code or not text.strip():
        if re.search(r"limit|usage|quota|reset", text, re.I):
            _CLAUDE_REST[0] = time.time() + 3600
        raise LLMUnavailable(f"claude -p search error: {text[:80] or 'no answer'}")
    USAGE["claude"] += 1
    _log(f"claude/{model} search answered in {time.time() - started:.1f}s, {len(seen)} sources")
    return {"text": text.strip(), "sources": [{"title": t, "uri": u} for u, t in seen.items()]}


def _search_gemini(prompt: str, system: str | None, timeout: float) -> dict:
    """A Gemini answer grounded in a live Google search. Uses the same Gemini keys as _cloud, rotated, a limited key resting."""
    cfg = _cfg().get("cloud") or {}
    keys = [k for p, k in _pool() if p == "gemini"]
    if not cfg.get("enabled") or not keys:
        raise LLMUnavailable("web search needs a Gemini key")
    with _LOCK:
        turn = next(_TURN)
    body: dict[str, Any] = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "tools": [{"google_search": {}}],
                            "generationConfig": {"temperature": 0.1}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    deadline = time.time() + float(cfg.get("search_budget_seconds", 75))
    for model in _models(cfg, "gemini"):
        for i in range(len(keys)):
            key = keys[(turn + i) % len(keys)]
            kid = f"search:{model}:{key[-6:]}"
            left = deadline - time.time()
            if _REST.get(kid, 0) > time.time():
                continue
            if left < 5:
                raise LLMUnavailable("web search ran out of time")
            started = time.time()
            try:
                out = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", body,
                           {"x-goog-api-key": key}, timeout=min(timeout, left))
            except RateLimited as e:
                _REST[kid] = time.time() + e.retry_after
                _log(f"search {model} key ...{key[-4:]} rate limited ({time.time() - started:.1f}s)")
                continue
            except LLMUnavailable as e:
                _REST[kid] = time.time() + (120 if "timed out" in str(e) else 30)
                _log(f"search {model} key ...{key[-4:]} failed: {str(e)[-50:]} ({time.time() - started:.1f}s)")
                continue
            cand = (out.get("candidates") or [{}])[0]
            text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []))
            chunks = (cand.get("groundingMetadata") or {}).get("groundingChunks") or []
            sources = [{"title": (c.get("web") or {}).get("title", ""), "uri": (c.get("web") or {}).get("uri", "")} for c in chunks if c.get("web")]
            if text.strip():
                _log(f"search {model} answered in {time.time() - started:.1f}s, {len(sources)} sources")
                return {"text": text.strip(), "sources": sources}
    raise LLMUnavailable("no Gemini key could run the web search")


def cloud_ready() -> bool:
    """Is there a hosted key that is not resting? The batch writer only starts when it can finish on a hosted model."""
    if not (_cfg().get("cloud") or {}).get("enabled"):
        return False
    now = time.time()
    return any(_REST.get(f"{p}:{m}:{k[-6:]}", 0) <= now for p, k in _pool() for m in _models(_cfg()["cloud"], p))


BACKENDS: dict[str, Callable[..., str]] = {"cloud": _cloud, "claude": _claude}


def call(prompt: str, *, system: str | None = None, temperature: float | None = None, json_mode: bool = False,
         num_ctx: int = 0, timeout: int = _TIMEOUT, num_predict: int = 0, tier: str = "cloud") -> str:
    """Hosted models first, then the configured fallback (claude -p). tier="cloud_only" is for a call that is only worth making on a
    hosted model (the batch writer): no fallback. num_ctx is kept for the callers that pass it and ignored."""
    cfg = _cfg()
    temp = cfg["temperature"] if temperature is None else temperature
    cloud_on = bool((cfg.get("cloud") or {}).get("enabled"))
    if tier == "cloud_only":
        if not cloud_on:
            raise LLMUnavailable("hosted models are off")
        return _cloud(prompt, system, temp, json_mode, num_ctx, min(timeout, 120), num_predict)
    order = (["cloud"] if cloud_on else []) + [cfg.get("backend", "claude")]
    last: Exception | None = None
    for name in order:
        if name not in BACKENDS:
            raise ValueError(f"Unknown llm backend: {name}")
        try:
            if name != "cloud" and order[0] == "cloud":
                USAGE["after_cloud"] = USAGE.get("after_cloud", 0) + 1
            return BACKENDS[name](prompt, system, temp, json_mode, num_ctx, min(timeout, 120 if name == "claude" else 90), num_predict)
        except LLMUnavailable as e:
            last = e
    raise LLMUnavailable(str(last))


def call_json(prompt: str, *, system: str | None = None, temperature: float | None = None, num_ctx: int = 0,
              timeout: int = _TIMEOUT, num_predict: int = 0, tier: str = "cloud") -> Any:
    raw = call(prompt, system=system, temperature=temperature, json_mode=True, num_ctx=num_ctx, timeout=timeout, num_predict=num_predict, tier=tier)
    clean = raw.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM did not return valid JSON:\n{raw[:300]}") from e


def embed(texts: list[str]) -> list[list[float]]:
    """There is no embedding model: callers fall back to matching questions by wording (embed.lexical_score)."""
    raise LLMUnavailable("no embedding model")


def status() -> dict:
    """For the side panel and the doctor: which models can answer."""
    cfg = _cfg()
    cl = cfg.get("cloud") or {}
    keys = len(_pool()) if cl.get("enabled") else 0
    claude = shutil.which("claude") is not None
    names = [n for n, ok in (("Groq and Gemini", keys > 0), ("Claude", claude)) if ok]
    return {"ok": bool(names), "backend": cfg.get("backend", "claude"), "chat_model": " then ".join(names) or None, "embeddings": False,
            "cloud": {"enabled": bool(cl.get("enabled")), "keys": keys, **USAGE}, "claude": claude}

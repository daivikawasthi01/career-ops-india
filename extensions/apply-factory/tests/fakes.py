"""A fake Ollama: deterministic bag-of-words vectors and scripted chat replies. No network."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path

from lib import db, llm
from lib import config

DIM = 64


def vec(text: str) -> list[float]:
    v = [0.0] * DIM
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1.0
    return v


class FakeOllama:
    def __init__(self, chat_replies=None, down=False):
        self.chat_replies = list(chat_replies or [])
        self.down = down
        self.chat_calls = 0

    def post(self, url, body, headers=None, timeout=0):
        if self.down:
            raise llm.LLMUnavailable("fake: down")
        if url.endswith("/api/embed"):
            return {"embeddings": [vec(t) for t in body["input"]]}
        if url.endswith("/api/chat"):
            self.chat_calls += 1
            reply = self.chat_replies.pop(0) if self.chat_replies else "{}"
            return {"message": {"content": reply if isinstance(reply, str) else json.dumps(reply)}}
        raise AssertionError(url)

    def get(self, url, timeout=5):
        if self.down:
            raise llm.LLMUnavailable("fake: down")
        return {"models": [{"name": "qwen2.5:7b-instruct"}, {"name": "nomic-embed-text:latest"}]}

    def install(self):
        self._saved = (llm.post, llm.get, dict(llm._chat_model_cache))
        llm.post, llm.get = self.post, self.get
        llm._chat_model_cache.clear()

    def uninstall(self):
        llm.post, llm.get, cache = self._saved
        llm._chat_model_cache.clear()
        llm._chat_model_cache.update(cache)


def temp_db() -> str:
    d = tempfile.mkdtemp(prefix="apply-factory-test-")
    path = str(Path(d) / "kb.sqlite")
    db.init(path, str(config.ROOT / "schema.sql"))
    return path

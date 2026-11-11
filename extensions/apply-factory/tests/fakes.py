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
    """Scripted model replies (the name is kept from when the model was local). Chat goes through the claude -p seam, embeddings
    through llm.embed; the hosted pool is empty so nothing reaches the network."""

    def __init__(self, chat_replies=None, down=False):
        self.chat_replies = list(chat_replies or [])
        self.down = down
        self.chat_calls = 0

    def claude(self, args, stdin, timeout, cwd):
        if self.down:
            raise llm.LLMUnavailable("fake: down")
        self.chat_calls += 1
        reply = self.chat_replies.pop(0) if self.chat_replies else "{}"
        return 0, json.dumps({"result": reply if isinstance(reply, str) else json.dumps(reply), "is_error": False})

    def post(self, url, body, headers=None, timeout=0):
        raise AssertionError(f"unexpected network call: {url}")

    def embed(self, texts):
        if self.down:
            raise llm.LLMUnavailable("fake: down")
        return [vec(t) for t in texts]

    def install(self):
        self._saved = (llm.post, llm.run_claude, llm.embed, llm._pool, llm.shutil.which)
        llm.post, llm.run_claude, llm.embed = self.post, self.claude, self.embed
        llm._pool = lambda: ()  # tests never use the real hosted keys
        llm.shutil.which = lambda name, *a, **k: "/usr/bin/claude" if name == "claude" else self._saved[4](name, *a, **k)
        llm._REST.clear()
        llm._CLAUDE_REST[0] = 0.0

    def uninstall(self):
        llm.post, llm.run_claude, llm.embed, llm._pool, llm.shutil.which = self._saved


def temp_db() -> str:
    d = tempfile.mkdtemp(prefix="apply-factory-test-")
    path = str(Path(d) / "kb.sqlite")
    db.init(path, str(config.ROOT / "schema.sql"))
    return path

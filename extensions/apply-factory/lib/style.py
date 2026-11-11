"""A person's own writing samples, kept on their Mac in data/style/, used to steer the model.

emails.md           cold emails they wrote and liked, separated by a line of ---. The model matches their voice, structure, greeting and sign-off.
cover-template.tex  a cover letter they wrote in their own LaTeX layout. The layout (preamble, header, recipient, closing) is kept exactly; only the
                    letter body, the recipient, the date and the subject line are replaced for each job, and the body is written to follow the sample's
                    structure and tone.

Nothing here is shared or shipped: the folder is under data/, which is never committed.
"""
from __future__ import annotations

import datetime
import re

from . import config, profile, tex

DIR = config.ROOT / "data" / "style"
MAX_SAMPLE = 6000


def _read(name: str) -> str:
    p = DIR / name
    return p.read_text(errors="ignore") if p.exists() else ""


def get() -> dict:
    return {"emails": _read("emails.md"), "cover_tex": _read("cover-template.tex")}


def set_(emails: str | None, cover_tex: str | None) -> dict:
    DIR.mkdir(parents=True, exist_ok=True)
    if emails is not None:
        emails = emails.strip()
        if len(emails) > 3 * MAX_SAMPLE:
            raise ValueError("That is too much text for email samples. Keep two or three.")
        (DIR / "emails.md").write_text(emails + "\n") if emails else (DIR / "emails.md").unlink(missing_ok=True)
    if cover_tex is not None:
        cover_tex = cover_tex.strip()
        if cover_tex:
            if r"\begin{document}" not in cover_tex or r"\end{document}" not in cover_tex:
                raise ValueError(r"That is not a complete LaTeX letter: it needs \begin{document} and \end{document}.")
            if len(cover_tex) > 20000:
                raise ValueError("That template is too long.")
            (DIR / "cover-template.tex").write_text(cover_tex + "\n")
        else:
            (DIR / "cover-template.tex").unlink(missing_ok=True)
    return get()


# ---- cold emails ----
def email_samples() -> list[str]:
    return [s.strip() for s in re.split(r"^\s*-{3,}\s*$", _read("emails.md"), flags=re.M) if len(s.strip()) > 40][:3]


_SIGNOFF = re.compile(r"^(kind regards|warm regards|best regards|regards|best|thanks|thank you|sincerely|yours sincerely|cheers)\b", re.I)


def email_parts(sample: str) -> tuple[str, str, str]:
    """(greeting word, body, sign-off block) of one sample email. The greeting word is the first word of its greeting line (Respected, Dear, Hi),
    and the sign-off block is kept as written, because a person's sign-off is theirs."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", sample.strip()) if p.strip()]
    greeting = ""
    if paras and len(paras[0].split()) <= 8 and "\n" not in paras[0]:
        greeting = paras.pop(0).split()[0].strip(",")
    sign = ""
    if paras and _SIGNOFF.match(paras[-1]):
        sign = paras.pop()
    return greeting, "\n\n".join(paras), sign


def words(text: str) -> int:
    return len(text.split())


# ---- cover letter in the person's own layout ----
def cover_template() -> str:
    return _read("cover-template.tex")


def _balanced(s: str, open_at: int) -> int:
    """Index just after the brace that closes the one at open_at, or -1."""
    depth = 0
    i = open_at
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _cmd_span(s: str, name: str) -> tuple[int, int, int] | None:
    """(start of the command, where its first argument's brace is, end of its last consecutive {} argument) for the first \\name in s."""
    m = re.search(rf"\\{name}(?![A-Za-z])(\[[^\]]*\])?", s)
    if not m:
        return None
    first = m.end()
    if first >= len(s) or s[first] != "{":
        return None
    end = _balanced(s, first)
    return (m.start(), first, end) if end > 0 else None


def _set_args(s: str, name: str, args: list[str], keep_optional: bool = True) -> str:
    span = _cmd_span(s, name)
    if not span:
        return s
    start, first, end = span
    # the command's existing arguments: consume as many {} groups as we are given new ones, so a two-argument command stays two-argument
    stop = first
    for _ in args:
        if stop < len(s) and s[stop] == "{":
            nxt = _balanced(s, stop)
            if nxt < 0:
                return s
            stop = nxt
        else:
            break
    optional = re.match(rf"\\{name}(\[[^\]]*\])?", s[start:]).group(1) or "" if keep_optional else ""
    return s[:start] + f"\\{name}{optional}" + "".join("{" + a + "}" for a in args) + s[stop:]


def bold(text: str) -> str:
    """Escape the text for LaTeX, turning **word** into \\textbf{word} (the sample letters use bold for the key tools and numbers)."""
    parts = re.split(r"(\*\*[^*]+\*\*)", text)
    return "".join("\\textbf{" + tex.escape(p[2:-2]) + "}" if p.startswith("**") and p.endswith("**") else tex.escape(p) for p in parts)


def template_body(template: str) -> str:
    """The sample letter's own paragraphs as plain text with **bold**, to show the model how this person writes."""
    m = re.search(r"\\makelettertitle(.*?)\\makeletterclosing", template, re.S) or re.search(r"%\s*AF:BODY\b(.*?)%\s*AF:END\b", template, re.S)
    if not m:
        m = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", template, re.S)
    body = m.group(1) if m else template
    body = re.sub(r"\\textbf\{([^{}]*)\}", r"**\1**", body)
    body = re.sub(r"\\(textcolor|textit|emph)\{[^{}]*\}\{([^{}]*)\}|\\(emph|textit)\{([^{}]*)\}", lambda mm: mm.group(2) or mm.group(4) or "", body)
    body = re.sub(r"\\[A-Za-z]+\*?(\[[^\]]*\])?", "", body).replace("{", "").replace("}", "").replace("\\%", "%").replace("\\", "")
    body = re.sub(r"^\s*(dear|hi|hello|respected)\b[^\n]*\n+", "", body.strip(), flags=re.I)   # the greeting is added per person, not copied
    return re.sub(r"\n{3,}", "\n\n", body).strip()


def from_template(template: str, body: str, company: str, greeting: str, subject: str, person: str = "") -> str:
    """Fill the person's own layout: their preamble and closing stay exactly as they wrote them."""
    f = profile.facts()
    marker = re.search(r"\\makelettertitle(.*?)\\makeletterclosing", template, re.S) or re.search(r"(%\s*AF:BODY\b)(.*?)(%\s*AF:END\b)", template, re.S)
    paras = "\n\n".join(bold(p.strip()) for p in body.split("\n\n") if p.strip())
    out = template
    if re.search(r"\\makelettertitle", template) and re.search(r"\\makeletterclosing", template):
        out = re.sub(r"(\\makelettertitle).*?(\\makeletterclosing)", lambda m: f"{m.group(1)}\n\n{tex.escape(greeting)}\n\n{paras}\n\n{m.group(2)}", template, count=1, flags=re.S)
    elif marker:
        out = re.sub(r"(%\s*AF:BODY\b).*?(%\s*AF:END\b)", lambda m: f"{m.group(1)}\n{tex.escape(greeting)}\n\n{paras}\n{m.group(2)}", template, count=1, flags=re.S)
    first, last = f.get("first_name", ""), f.get("last_name", "")
    if first or last:
        out = _set_args(out, "name", [tex.escape(first), tex.escape(last)])
    if f.get("email"):
        out = _set_args(out, "email", [tex.escape(f["email"])])
    if f.get("phone"):
        out = _set_args(out, "phone", [tex.escape(f["phone"])])
    where = ", ".join(x for x in (f.get("city"), f.get("country")) if x)
    if where:
        out = _set_args(out, "address", [tex.escape(where), ""])
    links = [re.sub(r"^https?://(www\.)?", "", f[k]).rstrip("/") for k in ("linkedin", "github") if f.get(k)]
    if links:
        out = _set_args(out, "extrainfo", [r" \\ ".join(tex.escape(x) for x in links)])
    out = _set_args(out, "recipient", [tex.escape(person) if person else "The Hiring Team", (tex.escape(company) + r", \\") if company else r"\\"])
    out = _set_args(out, "date", [f"{datetime.date.today():%d %B %Y}"])
    span = _cmd_span(out, "opening")
    if span and subject:
        _, first_brace, end = span
        arg = out[first_brace:end]
        i = arg.rfind("\\textbf{")
        text = "Sub: " + tex.escape(re.sub(r"^\s*sub(ject)?\s*:\s*", "", subject, flags=re.I))
        if i >= 0:
            inner = i + len("\\textbf")
            inner_end = _balanced(arg, inner)
            arg = arg[:inner] + "{" + text + "}" + arg[inner_end:]
        else:
            arg = "{" + text + "}"
        out = out[:first_brace] + arg + out[end:]
    label = re.sub(r"[\r\n%]+", " ", company or subject or "this job").strip()
    return re.sub(r"^%\s*Cover letter for .*$", lambda _: f"%Cover letter for {label}", out, count=1, flags=re.M)   # the sample's own comment names another company

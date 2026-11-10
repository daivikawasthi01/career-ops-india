"""
Structured resume data to a compiling tex file. The same data shape is what the PDF importer asks the model for,
so the model never writes LaTeX: it only fills fields, and this module owns every command and escape.

The summary and skills regions are wrapped in `% AF:BEGIN name` / `% AF:END name` comments. The tailor step edits
only text between such markers, so a hand-written tex needs the same two comment pairs to be tailorable.
"""
from __future__ import annotations

import re

from .tex import escape

REGIONS = ("summary", "skills")

PREAMBLE = r"""\documentclass[10pt,a4paper]{article}
\usepackage[margin=0.6in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem}
\usepackage{titlesec}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}
\titleformat{\section}{\large\bfseries}{}{0pt}{}[\titlerule]
\titlespacing*{\section}{0pt}{7pt}{3pt}
\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}
\newcommand{\entry}[4]{\textbf{#1}\hfill #2\\\textit{#3}\hfill\textit{#4}}
\begin{document}
"""


def marker(name: str, body: str) -> str:
    return f"% AF:BEGIN {name}\n{body.rstrip()}\n% AF:END {name}\n"


def region(tex: str, name: str) -> str | None:
    m = re.search(rf"% AF:BEGIN {name}\n(.*?)\n?% AF:END {name}", tex, re.S)
    return m.group(1) if m else None


def replace_region(tex: str, name: str, body: str) -> str:
    return re.sub(rf"(% AF:BEGIN {name}\n).*?(\n?% AF:END {name})", lambda m: m.group(1) + body.rstrip() + m.group(2), tex, count=1, flags=re.S)


def _bullets(items: list[str]) -> str:
    items = [i for i in items if str(i).strip()]
    if not items:
        return ""
    return "\\begin{itemize}\n" + "\n".join(f"  \\item {escape(i)}" for i in items) + "\n\\end{itemize}\n"


def _link(label: str, url: str) -> str:
    return f"\\href{{{url}}}{{{escape(label)}}}" if url else escape(label)


def render(d: dict) -> str:
    out = [PREAMBLE]
    contact = d.get("contact") or {}
    out.append(f"\\begin{{center}}\n{{\\LARGE\\bfseries {escape(d.get('name', ''))}}}\\\\[3pt]\n")
    bits = [escape(contact[k]) for k in ("phone", "email", "location") if contact.get(k)]
    bits += [_link(l.get("label", l.get("url", "")), l.get("url", "")) for l in contact.get("links", []) if l.get("url") or l.get("label")]
    out.append(" $|$ ".join(bits) + "\n\\end{center}\n")

    if d.get("summary"):
        out.append("\\section*{Summary}\n" + marker("summary", escape(d["summary"])))

    if d.get("education"):
        out.append("\\section*{Education}\n")
        for e in d["education"]:
            out.append(f"\\entry{{{escape(e.get('school', ''))}}}{{{escape(e.get('location', ''))}}}{{{escape(e.get('degree', ''))}}}{{{escape(e.get('dates', ''))}}}\n")
            out.append(_bullets(e.get("details", [])))
    if d.get("experience"):
        out.append("\\section*{Experience}\n")
        for e in d["experience"]:
            out.append(f"\\entry{{{escape(e.get('company', ''))}}}{{{escape(e.get('location', ''))}}}{{{escape(e.get('role', ''))}}}{{{escape(e.get('dates', ''))}}}\n")
            out.append(_bullets(e.get("bullets", [])))
    if d.get("projects"):
        out.append("\\section*{Projects}\n")
        for p in d["projects"]:
            title = _link(p.get("name", ""), p.get("url", ""))
            tech = f" $|$ \\textit{{{escape(p['tech'])}}}" if p.get("tech") else ""
            out.append(f"\\textbf{{{title}}}{tech}\\hfill {escape(p.get('dates', ''))}\n")
            out.append(_bullets(p.get("bullets", [])))
    if d.get("skills"):
        lines = [f"\\textbf{{{escape(g.get('group', ''))}}}: {escape(', '.join(g.get('items', [])))}\\\\" if g.get("group")
                 else f"{escape(', '.join(g.get('items', [])))}\\\\" for g in d["skills"]]
        out.append("\\section*{Skills}\n" + marker("skills", "\n".join(lines)))
    for o in d.get("other", []):
        out.append(f"\\section*{{{escape(o.get('heading', ''))}}}\n" + _bullets(o.get("bullets", [])))
    out.append("\\end{document}\n")
    return "\n".join(out)

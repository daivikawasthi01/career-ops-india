#!/usr/bin/env python3
"""Summarise a discover-ats.mjs progress log: hit rate overall, for the slice, and per section.

  python3 tools/discovery_report.py ~/discover.log ../companies.txt

A hit means a board was found, not that it has India entry-level postings. For that, run
board-india-check.mjs on the written boards.
"""

import re
import sys
from collections import defaultdict
from pathlib import Path

LINE = re.compile(r"^\[(\d+)/(\d+)\] (.+) (✓|✗|⏱ timeout)$")


def parse_log(text):
    """name -> mark, from the progress lines of a discovery log."""
    marks = {}
    for line in text.splitlines():
        m = LINE.match(line.rstrip())
        if m:
            marks[m.group(3)] = m.group(4)
    return marks


def parse_companies(text):
    """(section_of, slice_names). A name before any section header gets the section '(no section)'."""
    section_of, slice_names = {}, set()
    section, in_slice = "(no section)", False
    for raw in text.splitlines():
        line = raw.strip()
        if "SLICE 1 BEGIN" in line:
            in_slice = True
        elif "SLICE 1 END" in line:
            in_slice = False
        elif line.startswith("# ----------"):
            section = line.strip("# -").strip() or "(unnamed section)"
        elif line and not line.startswith("#"):
            section_of.setdefault(line, "Slice 1 (priority names)" if in_slice else section)
            if in_slice:
                slice_names.add(line)
    return section_of, slice_names


def rate(hits, total):
    return f"{hits}/{total} ({100 * hits / total:.0f}%)" if total else "0/0"


def report(marks, section_of, slice_names):
    out = [f"names processed: {len(marks)}"]
    hit = {n for n, m in marks.items() if m == "✓"}
    in_slice = [n for n in marks if n in slice_names]
    rest = [n for n in marks if n not in slice_names]
    out.append(f"slice 1:  {rate(sum(n in hit for n in in_slice), len(in_slice))}")
    out.append(f"the rest: {rate(sum(n in hit for n in rest), len(rest))}")
    out.append(f"timeouts: {sum(m.startswith('⏱') for m in marks.values())}")
    by_section = defaultdict(lambda: [0, 0])
    for name, mark in marks.items():
        sec = section_of.get(name) or "(not in companies.txt)"
        by_section[sec][1] += 1
        by_section[sec][0] += mark == "✓"
    out.append("by section:")
    for sec, (h, n) in sorted(by_section.items(), key=lambda kv: -kv[1][1]):
        out.append(f"  {sec[:62]:<62} {rate(h, n)}")
    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    log = Path(sys.argv[1]).expanduser().read_text()
    companies = Path(sys.argv[2]).expanduser().read_text()
    print(report(parse_log(log), *parse_companies(companies)))

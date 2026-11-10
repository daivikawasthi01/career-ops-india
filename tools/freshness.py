"""Freshness gate: only recent, fresher-level jobs reach the database, the Telegram ping and the workbook.

One place for the rule, applied to every merged row whichever scanner found it:
  stale       the posting date is older than the limit: freshness.max_age_days for boards and aggregators,
              freshness.employer_max_age_days for company career pages and ATS boards (employer-confirmed rows), which hire
              over long windows, so their limit is soft and an undated employer row is kept
  undated     no posting date on a board row, and none of the sources that found it limits the age in its own query
              (freshness.undated_ok_steps: their scan window; undated_ok_sources: feeds that list newest jobs first)
  experience  the title states a minimum above max_min_experience_years ("(3-5 Years)", "2 - 4 yrs")
"""
import re
from collections import Counter
from datetime import date, datetime

TITLE_YEARS = re.compile(r"(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*\d{1,2}\s*)?(?:years?|yrs?)\b", re.I)


def title_min_years(title):
    """Lowest stated minimum years in a title, or None when it states none."""
    found = [int(m.group(1)) for m in TITLE_YEARS.finditer(title or "")]
    return min(found) if found else None


def posted_date(value):
    """The posting day as a date, or None when absent or unreadable."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def verdict(row, rules, max_years=0, today=None):
    """None when the row is recent and fresher-level, otherwise 'stale', 'undated' or 'experience'."""
    today = today or date.today()
    years = title_min_years(row.get("title"))
    if years is not None and years > max_years:
        return "experience"
    rules = rules or {}
    employer = row.get("confidence") == "employer-confirmed"
    max_age = rules.get("employer_max_age_days") if employer else rules.get("max_age_days")
    if not max_age:
        return None
    posted = posted_date(row.get("posted"))
    if posted is None:
        if employer:
            return None  # a company's own page does not date every posting; it is not judged on age
        steps_ok = set(rules.get("undated_ok_steps") or [])
        sources_ok = set(rules.get("undated_ok_sources") or [])
        if set(row.get("steps") or ()) & steps_ok or set(row.get("found_by") or ()) & sources_ok:
            return None
        return "undated"
    return "stale" if (today - posted).days > max_age else None


def apply(rows, rules, max_years=0, today=None):
    """(kept rows, Counter of dropped reasons)."""
    kept, dropped = [], Counter()
    for row in rows:
        why = verdict(row, rules, max_years, today)
        if why:
            dropped[why] += 1
        else:
            kept.append(row)
    return kept, dropped

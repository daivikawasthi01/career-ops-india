"""Company tab backend: public-page contacts, sourced people, email guessing and the no-DATA mail check. No network, no real mail server."""
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from lib import company, config, db, llm, mailcheck
from tests.fakes import FakeOllama, temp_db


class FakeSMTP:
    """Answers RCPT from a table; records everything said, so a test can prove DATA was never sent."""
    log: list = []
    table: dict = {}
    by_host: dict = {}    # {"mx.acme.com": {"local part": reply}} overrides the table for one server
    refuse_connection = False

    def __init__(self, host, port, local_hostname=None, timeout=0):
        if FakeSMTP.refuse_connection:
            raise OSError("connection refused")
        FakeSMTP.log.append(("connect", host))
        self.host = host

    def ehlo(self): FakeSMTP.log.append(("ehlo",)); return 250, b"ok"
    def rset(self): FakeSMTP.log.append(("rset",)); return 250, b"ok"
    def mail(self, sender): FakeSMTP.log.append(("mail", sender)); return 250, b"ok"
    def data(self, msg): FakeSMTP.log.append(("data",)); return 250, b"ok"
    def quit(self): FakeSMTP.log.append(("quit",))

    def rcpt(self, addr):
        FakeSMTP.log.append(("rcpt", addr))
        local = addr.split("@")[0]
        mine = FakeSMTP.by_host.get(self.host)
        if mine is not None:
            return mine.get(local, mine.get("*", (550, b"5.1.1 user unknown")))
        return FakeSMTP.table.get(local, FakeSMTP.table.get("*", (550, b"5.1.1 user unknown")))


def dns(mx="10 aspmx.l.google.com.", txt=None):
    def fake(name, rtype, timeout=6):
        if rtype == "MX":
            return {"Answer": [{"data": mx}]} if mx else {}
        if name.startswith("_dmarc"):
            return {"Answer": [{"data": '"v=DMARC1; p=reject"'}]}
        return {"Answer": [{"data": '"v=spf1 include:_spf.google.com ~all"'}]}
    return fake


class MailTest(unittest.TestCase):
    def setUp(self):
        self._saved = (mailcheck.doh, mailcheck.smtp_factory, mailcheck.sleep)
        mailcheck.doh, mailcheck.smtp_factory, mailcheck.sleep = dns(), FakeSMTP, lambda s: None
        FakeSMTP.log, FakeSMTP.table, FakeSMTP.by_host, FakeSMTP.refuse_connection = [], {}, {}, False

    def tearDown(self):
        mailcheck.doh, mailcheck.smtp_factory, mailcheck.sleep = self._saved

    def test_candidates_follow_the_companys_own_shape(self):
        out = [c["address"] for c in mailcheck.candidates("Priya Sharma", "acme.com", ["john.doe@acme.com", "info@acme.com"])]
        self.assertEqual(out[:3], ["priya.sharma@acme.com", "priya@acme.com", "psharma@acme.com"])
        out = [c["address"] for c in mailcheck.candidates("Priya Sharma", "acme.com", ["john_doe@acme.com"])]
        self.assertEqual(out[0], "priya_sharma@acme.com")
        self.assertEqual(mailcheck.candidates("Cher", "acme.com")[0]["address"], "cher@acme.com")      # one name: no last-name shapes
        self.assertTrue(all("é" not in c["address"] for c in mailcheck.candidates("José Núñez", "acme.com")))

    def test_the_usual_shapes_are_all_covered(self):
        got = {c["address"].split("@")[0] for c in mailcheck.candidates("Priya Sharma", "acme.com", limit=30)}
        for want in ("priya", "sharma", "priya.sharma", "sharma.priya", "psharma", "priyas", "priyasharma", "priya_sharma", "sharmap", "p.sharma", "priya.s", "sharma_priya", "ps"):
            self.assertIn(want, got)

    def test_a_company_that_cuts_user_names_is_recognised_and_tried(self):
        self.assertEqual(mailcheck.shape_of("Priya Sharma", "psharma@acme.com"), "flast")
        self.assertEqual(mailcheck.shape_of("Priya Bhattacharya", "pbhattac@acme.com"), "flast:8")       # f + 7 letters: an 8 character user name
        self.assertEqual(mailcheck.shape_of("Priya Sharma", "priya.sharma@acme.com"), "first.last")
        self.assertIsNone(mailcheck.shape_of("Priya Sharma", "someoneelse@acme.com"))
        self.assertEqual(mailcheck.learn_shapes([("Priya Bhattacharya", "pbhattac@acme.com"), ("Rahul Venkataraman", "rvenkata@acme.com"), ("Amit Rao", "arao@acme.com")]),
                         ["flast:8", "flast"])                                                           # the cut shape is seen twice
        out = [c["address"] for c in mailcheck.candidates("Anirudh Subramaniam", "acme.com", prefer=["flast:8"])]
        self.assertEqual(out[0], "asubrama@acme.com")                                                    # the learned cut is tried first
        long = {c["address"].split("@")[0] for c in mailcheck.candidates("Anirudh Subramaniam", "acme.com", limit=40)}
        self.assertTrue({"asubrama", "asubram", "asubra"} <= long)                                     # cut forms are tried for long names even when none is known

    def test_every_shape_is_tried_and_an_initial_gives_only_first_name_guesses(self):
        every = [c["shape"] for c in mailcheck.candidates("Priya Sharma", "acme.com")]
        self.assertGreaterEqual(len(every), 13)
        self.assertEqual([c["address"] for c in mailcheck.candidates("Ravi K.", "acme.com")], ["ravi@acme.com"])
        pref = mailcheck.candidates("Priya Sharma", "acme.com", prefer=["flast"])
        self.assertEqual(pref[0]["address"], "psharma@acme.com")                                        # the shape that worked before goes first

    def test_mailbox_found_when_the_control_is_refused_and_the_candidate_accepted(self):
        FakeSMTP.table = {"priya.sharma": (250, b"ok")}
        out = mailcheck.find("Priya Sharma", "acme.com")
        top = out["rows"][0]
        self.assertEqual((top["address"], top["verdict"], out["catch_all"], out["provider"]), ("priya.sharma@acme.com", "accepted", False, "google"))
        self.assertEqual(top["risk"]["bounce"]["band"], "low")
        self.assertEqual([r["verdict"] for r in out["rows"][1:]], ["rejected"] * (len(out["rows"]) - 1))
        self.assertNotIn(("data",), FakeSMTP.log)                                                      # a check never sends a message
        self.assertIn(("mail", ""), FakeSMTP.log)                                                      # null sender
        self.assertEqual(FakeSMTP.log.count(("connect", "aspmx.l.google.com")), 1)                    # one session for all the probes

    def test_the_domain_that_accepts_a_pattern_is_the_companys_and_gets_the_rest(self):
        FakeSMTP.by_host = {"mx.acme.com": {"priya.sharma": (250, b"ok")}}
        mailcheck.doh = lambda name, rtype, timeout=6: ({"Answer": [{"data": "10 mx." + name + "."}]} if rtype == "MX" else {})
        out = mailcheck.find_multi("Priya Sharma", ["goldmansachs.com", "acme.com"])   # the first domain refuses, the second accepts
        self.assertEqual((out["domain"], out["domains_tried"]), ("acme.com", ["goldmansachs.com", "acme.com"]))
        self.assertEqual(out["rows"][0]["address"], "priya.sharma@acme.com")
        self.assertGreaterEqual(sum(1 for r in out["rows"] if r["address"].endswith("@acme.com")), 12)  # every pattern tried on the winner
        self.assertEqual(sum(1 for r in out["rows"] if r["address"].endswith("@goldmansachs.com")), 3)  # only the top three on the loser

    def test_a_catch_all_server_proves_nothing(self):
        FakeSMTP.table = {"*": (250, b"ok")}
        out = mailcheck.find("Priya Sharma", "acme.com")
        self.assertEqual({r["verdict"] for r in out["rows"]}, {"catch-all"})
        self.assertTrue(out["catch_all"])
        self.assertEqual(out["rows"][0]["risk"]["bounce"]["band"], "medium")

    def test_unreachable_and_greylisted_are_not_guessed_at(self):
        FakeSMTP.refuse_connection = True
        out = mailcheck.find("Priya Sharma", "acme.com")
        self.assertEqual({r["verdict"] for r in out["rows"]}, {"unreachable"})
        FakeSMTP.refuse_connection = False
        FakeSMTP.table = {"*": (451, b"4.7.1 greylisted, try later")}
        self.assertEqual({r["verdict"] for r in mailcheck.find("Priya Sharma", "acme.com")["rows"]}, {"temporary"})

    def test_a_domain_with_no_mail_server(self):
        mailcheck.doh = dns(mx=None)
        out = mailcheck.find("Priya Sharma", "nomail.example")
        self.assertEqual({r["verdict"] for r in out["rows"]}, {"no-mail-server"})
        self.assertEqual(out["rows"][0]["risk"]["bounce"]["band"], "high")
        self.assertEqual(FakeSMTP.log, [])

    def test_probes_are_capped(self):
        with mock.patch.object(mailcheck, "cfg", lambda: {**mailcheck._DEFAULTS, "max_probes": 3}):
            out = mailcheck.generic("acme.com")
        self.assertEqual(sum(1 for r in out["rows"] if r["verdict"] == "skipped"), len(mailcheck._DEFAULTS["generic"]) - 3)
        self.assertEqual(sum(1 for e in FakeSMTP.log if e[0] == "rcpt"), 3 + 1)                       # three candidates plus the control

    def test_risk_bands_name_their_reasons_and_say_they_are_estimates(self):
        r = mailcheck.risk("rejected", "proofpoint", {"dmarc": "reject"}, "info@acme.com")
        self.assertEqual((r["bounce"]["band"], r["spam"]["band"]), ("high", "high"))
        self.assertTrue(any("gateway" in w for w in r["spam"]["why"]))
        self.assertIn("not a measured", r["note"])
        self.assertEqual(mailcheck.risk("accepted", "google", {}, "priya@acme.com")["spam"]["band"], "low")

    def test_provider_and_policy(self):
        self.assertEqual(mailcheck.provider(["acme-com.mail.protection.outlook.com"]), "microsoft")
        self.assertEqual(mailcheck.provider(["mx1.pphosted.com"]), "proofpoint")
        self.assertEqual(mailcheck.provider(["mail.acme.com"]), "other")
        self.assertEqual(mailcheck.policy("acme.com"), {"spf": True, "dmarc": "reject"})


PAGE = '''<a href="mailto:hello@acme.com">hi</a> careers [at] acme [dot] com <img src="logo@2x.png">
<a href="tel:+91%2098765%2043210">call</a> other@gmail.com press@sub.acme.com'''


class CompanyTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOllama()
        self.fake.install()
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "disc.tsv").write_text("company\tdomain\nAcme Pvt Ltd\tacme.com\n")
        (self.tmp / "dir.tsv").write_text("company\tcareers_url\nBeta Labs\thttps://careers.beta.co.in/jobs\nGamma\thttps://boards.greenhouse.io/gamma\n")
        paths = {"careers_discovery": self.tmp / "disc.tsv", "careers_directory": self.tmp / "dir.tsv", "connections": self.tmp / "none.csv"}
        self._p = mock.patch.object(config, "path", lambda key, section="paths": paths[key])
        self._p.start()
        self._saved = (company.fetch_text, company.search)

    def tearDown(self):
        self._p.stop()
        company.fetch_text, company.search = self._saved
        self.fake.uninstall()

    def test_domain_comes_from_discovery_then_directory_then_job_link_never_a_job_board(self):
        self.assertEqual(company.domain_for("Acme", ""), ("acme.com", "scanner discovery"))
        self.assertEqual(company.domain_for("Beta Labs", ""), ("beta.co.in", "careers directory"))
        self.assertEqual(company.domain_for("Gamma", "https://boards.greenhouse.io/gamma/jobs/1"), ("", ""))
        self.assertEqual(company.domain_for("Delta", "https://careers.delta.io/x"), ("delta.io", "job link"))

    def test_contacts_are_only_the_companys_own_and_carry_their_page(self):
        emails, phones = company.extract_contacts(PAGE, "acme.com", "https://acme.com/contact")
        self.assertEqual(sorted(e["address"] for e in emails), ["careers@acme.com", "hello@acme.com", "press@sub.acme.com"])
        self.assertEqual([p["number"] for p in phones], ["+91 98765 43210"])
        self.assertTrue(all(e["source"] == "https://acme.com/contact" for e in emails))

    def test_crawl_honours_robots_txt(self):
        asked = []
        def fetch(url, timeout=8):
            asked.append(url)
            if url.endswith("robots.txt"):
                return 200, "User-agent: *\nDisallow: /team\n"
            return (200, PAGE) if url.endswith("/contact") or url.endswith("/") else (404, "")
        company.fetch_text = fetch
        out = company.crawl("acme.com")
        self.assertNotIn("https://acme.com/team", asked)
        self.assertEqual(len(out["emails"]), 3)
        self.assertEqual(len(out["pages"]), 2)

    def _mx(self, *domains):
        mailcheck.doh = lambda name, rtype, timeout=6: ({"Answer": [{"data": "10 mx." + name + "."}]} if rtype == "MX" and name in domains else {})

    def test_people_need_a_source_the_search_really_returned(self):
        company.fetch_text = lambda url, timeout=8: (404, "")
        self._mx("acme.com")
        overview = {"text": json.dumps({"employees": "3,300", "employees_note": "about 3,300 (Aug 2024)", "hq": "Bengaluru", "summary": "Payments.", "source": "https://acme.com/about"}),
                    "sources": [{"title": "About", "uri": "https://acme.com/about"}]}
        people = {"text": "```json\n" + json.dumps({"people": [
            {"name": "Ada Lovelace", "title": "CTO", "kind": "engineering", "source": "https://news.example/ada", "linkedin": "https://linkedin.com/in/ada"},
            {"name": "Made Up", "title": "CEO", "kind": "founder", "source": "https://nowhere.example/x"},
            {"name": "Cher", "title": "Head", "kind": "other", "source": "https://news.example/cher"}]}) + "\n```",
            "sources": [{"title": "News", "uri": "https://news.example/a"}]}
        prompts = []
        def fake(prompt, **kw):
            prompts.append(prompt)
            return overview if "employees" in prompt else (people if "Find the CURRENT people" in prompt else {"text": "{}", "sources": []})
        company.search = fake
        out = company.research("Acme", "", "Backend Engineer")
        self.assertEqual((out["size"]["employees"], out["size"]["band"], out["domain"], out["domain_from"]), (3300, "large", "acme.com", "scanner discovery"))
        self.assertEqual([p["name"] for p in out["people"]], ["Ada Lovelace"])                         # the invented name and the one-word name are dropped
        self.assertEqual(out["people"][0]["linkedin"], "https://linkedin.com/in/ada")
        ask = [q for q in prompts if "Find the CURRENT people" in q]
        self.assertIn("Backend Engineer", ask[0])                                                       # the hiring team for this job is searched first
        self.assertEqual(len(ask), 6)                                                                   # people_queries caps the searches
        self.assertTrue(any("based in Bangalore" in q for q in ask) and any("based in Hyderabad" in q for q in ask) and any("based in Gurugram" in q for q in ask))
        self.assertTrue(any("left out" in w for w in out["warnings"]))

    def test_the_job_city_replaces_the_default_cities(self):
        plan = company._people_plan(["a role"], "SRE", "Pune")
        self.assertEqual(plan, ['the hiring manager, team lead or recruiter for a "SRE" role in Pune', "HR, talent acquisition or technical recruiters based in Pune", "a role"])
        plan = company._people_plan([], "", "")
        self.assertEqual(plan, [f"HR, talent acquisition or technical recruiters based in {c}" for c in ("Bangalore", "Hyderabad", "Gurugram")])

    def test_people_searches_merge_and_stop_early_when_there_are_enough(self):
        seen = []
        def person(n, src="https://news.example/p"):
            return {"name": f"Person {'abcdefg'[n - 1].upper()}erson", "title": "x", "kind": "other", "source": src}
        batches = iter([[person(1), person(2), person(3)], [person(3), person(4), person(5), person(6)], [person(7)]])
        def fake(prompt, **kw):
            seen.append(prompt)
            return {"text": json.dumps({"people": next(batches)}), "sources": [{"title": "N", "uri": "https://news.example/a"}]}
        company.search = fake
        with mock.patch.object(company, "_cfg", lambda: {**config.load()["company"], "people_target": 6}):
            people, _, _ = company.research_people("Acme", "acme.com", "mid", "")
        self.assertEqual([p["name"] for p in people], [f"Person {c}erson" for c in "ABCDEF"])           # person C was found twice, listed once
        self.assertEqual(len(seen), 2)                                                                  # six people found: the third search never ran

    def test_email_domain_can_differ_from_the_website(self):
        self.assertEqual(company.domain_guesses("Goldman Sachs", "goldmansachs.com")[:3], ["gs.com", "goldman.com", "goldmansachs.com"])
        self.assertEqual(company.domain_guesses("Razorpay", "razorpay.com"), ["razorpay.com"])
        self.assertEqual(company.domain_guesses("Acme Pvt Ltd", "acme.co.in")[:2], ["co.in" and "acme.co.in", "acme.com"])
        self._mx("gs.com", "goldmansachs.com")
        seen = []
        def fake(prompt, **kw):
            seen.append(prompt)
            return {"text": json.dumps({"domains": [{"domain": "gs.com", "pattern": "firstname.lastname@gs.com", "source": "https://gs.example/faq"},
                                                    {"domain": "bogus.example", "pattern": None, "source": "https://elsewhere.example/x"}]}),
                    "sources": [{"title": "FAQ", "uri": "https://gs.example/faq"}]}
        company.search = fake
        doms, shapes, examples = company.email_domains("Goldman Sachs", "goldmansachs.com")
        self.assertEqual([(d["domain"], d["from"]) for d in doms], [("gs.com", "web search"), ("goldmansachs.com", "website")])   # bogus.example has no mail server: dropped
        self.assertEqual(shapes, ["first.last"])
        self.assertEqual(examples, [])
        self.assertIsNone(mailcheck.shape_from_pattern("{first_initial}{last}@x.com"))                  # unknown wording is not guessed at
        self.assertEqual([mailcheck.shape_from_pattern(t) for t in ("first.last", "FirstName.LastName@gs.com", "first initial+last name", "flast")], ["first.last", "first.last", "flast", "flast"])

    def test_example_addresses_from_a_page_teach_the_shape_and_untrusted_ones_do_not(self):
        self._mx("gs.com")
        def fake(prompt, **kw):
            return {"text": json.dumps({"domains": [], "examples": [
                {"name": "Priya Bhattacharya", "email": "pbhattac@gs.com", "source": "https://press.example/a"},
                {"name": "Rahul Venkataraman", "email": "rahul.v@gs.com", "source": "https://nowhere.example/z"}]}),
                "sources": [{"title": "P", "uri": "https://press.example/a"}]}
        company.search = fake
        doms, shapes, examples = company.email_domains("Goldman Sachs", "")
        self.assertEqual((shapes, [e["address"] for e in examples], doms[0]["domain"]), (["flast:8"], ["pbhattac@gs.com"], "gs.com"))

    def test_a_failed_later_search_keeps_what_was_found(self):
        calls = []
        def fake(prompt, **kw):
            calls.append(1)
            if len(calls) == 2:
                raise llm.LLMUnavailable("limited")
            return {"text": json.dumps({"people": [{"name": "Ada Lovelace", "title": "CTO", "kind": "engineering", "source": "https://news.example/a"}]}),
                    "sources": [{"title": "N", "uri": "https://news.example/a"}]}
        company.search = fake
        self.assertEqual([p["name"] for p in company.research_people("Acme", "acme.com", "mid", "")[0]], ["Ada Lovelace"])
        calls.clear(); calls.append(1)
        with self.assertRaises(llm.LLMUnavailable):                                                    # nothing found at all: the error is shown, not hidden
            company.research_people("Acme", "acme.com", "mid", "")

    def test_size_bands(self):
        self.assertEqual([company.band_for(n) for n in (None, 12, 200, 2000, 90000)], ["unknown", "startup", "small", "mid", "large"])

    def test_cache_round_trip_and_expiry(self):
        path = temp_db()
        with db.tx(path) as conn:
            self.assertIsNone(company.cached(conn, "Acme"))
            company.store(conn, "Acme Pvt Ltd", {"company": "Acme", "people": []})
            self.assertEqual(company.cached(conn, "acme")["company"], "Acme")                           # same company, different spelling
            conn.execute("UPDATE company_cache SET created_at='2000-01-01 00:00:00'")
            self.assertIsNone(company.cached(conn, "Acme"))

    def test_network_reads_only_when_a_connections_file_exists(self):
        self.assertEqual(company.network("Acme"), [])
        (self.tmp / "none.csv").write_text("x")
        out = json.dumps({"targets": [{"connections": [{"name": "Sam", "title": "SRE", "url": "https://linkedin.com/in/sam"}]}]})
        with mock.patch.object(company.nodecli, "run", lambda args, timeout=30: (0, out, "")):
            self.assertEqual(company.network("Acme"), [{"name": "Sam", "title": "SRE", "url": "https://linkedin.com/in/sam"}])


if __name__ == "__main__":
    unittest.main()

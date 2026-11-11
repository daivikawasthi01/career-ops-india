# apply-factory

Fills job application forms from your own earlier answers and learns the ones you type. Two parts:

- `browser/` is a Chrome extension (Manifest V3) with a side panel.
- `server.py` is a local API on `127.0.0.1:8765` that holds the knowledge base (`kb.sqlite`) and talks to a local Ollama model.

Nothing leaves your Mac unless you set `llm.fallback: groq` in `config.yaml`.

## Set up

```bash
brew install ollama tectonic poppler && brew services start ollama
ollama pull nomic-embed-text qwen3:8b

cd extensions/apply-factory
.venv/bin/python orchestrator.py init          # creates kb.sqlite (also run on every server start)
.venv/bin/python orchestrator.py serve         # or: install-service --load, to start at login
```

Load the extension: `chrome://extensions`, turn on Developer mode, Load unpacked, pick `extensions/apply-factory/browser`.
Click the toolbar icon to open the side panel. The first call pairs the extension with the server; only that browser profile can use it afterwards (`serve --reset-pair` forgets it).

Edit `facts.yml` for the things the extension may fill without asking.

CV files go in `output/resumes/`: `Daivik-Awasthi-Resume.pdf` is attached by default and `Daivik-Awasthi-DevopsResume.pdf` for DevOps, SRE, platform and cloud roles (the role is read from the page title, the heading and the job text; `resume_roles` in `rules/rules.json`, paths in `config.yaml`). If the DevOps file is missing the default is used. An existing upload is never replaced.

## How it decides

For each field on a page, in order:

1. Skip rules (`rules/rules.json`): private fields (passwords, OTP, card, Aadhaar, PAN) are never read; consent and signature boxes are never touched.
2. Your own earlier answer to the same wording.
3. A profile fact (`facts.yml`), recognised from the `autocomplete` attribute or the label.
4. An earlier answer to a near-identical question (vector match, higher bar for yes/no answers).
5. Otherwise the panel offers **Draft**: one call to the local model, grounded in `cv.md`, the job page text and your closest past long answers. It says UNKNOWN when the CV does not decide it, and a draft is only inserted when you press Use.

Gender, disability, salary, notice period, visa and similar fields are never drafted. They are filled only from an answer you gave before or a fact you listed.

Dropdowns and radios are matched by `lib/options.py` (aliases like India/Indian, NSUT/NSIT, B.Tech/Bachelor of Technology, then fuzzy matching). Custom dropdowns (React-Select, Workday) are opened, their options read, and the same matcher picks one.

## How it learns

When you press a Next or Submit style button, or a form submits, the extension reads the fields as they are at that moment and sends them to `/capture`. It never clicks Submit and never blocks your click. The server:

- maps each label to a question type (stored wording, then fact pattern, then vector match, then the model),
- stores short answers as new, confirmed or changed (history in `learning_events`),
- keeps long free-text answers only as writing samples for drafting, never as reusable answers,
- queues a field if the model is down and retries it on the next start (`orchestrator.py retry`).

## Site modes

Per site, from the side panel: Off, Watch (learns, fills nothing) or Fill. LinkedIn, Naukri and Indeed default to Watch, Glassdoor to Off. Sites outside the list are not touched until you press "Turn on for this site" in the panel. The list lives in `rules/rules.json`; after editing it run `.venv/bin/python browser/build.py` to regenerate `browser/manifest.json`.

## CV studio

Open it from the panel ("Open CV studio") or from "Tailor my CV". It runs in a browser tab and has three views.

- **Edit.** Your CV as tex on the left, the compiled pages on the right. It recompiles a second after you stop typing; compile errors list with their line numbers, "Fix with AI" asks the local model to repair them, and "Publish" compiles and then replaces the PDF in `output/resumes/` (the default, DevOps or AI slot). A failed compile never replaces a working PDF. The previous tex is kept as `<slot>.previous.tex`.
- **Import PDF.** The local model reads the PDF text into structured fields, a template writes the tex, tectonic compiles it, and compile errors go back to the model for up to three fixes. You see your original beside the compiled result, and every piece of text the model returned that is not in the PDF is listed. Nothing replaces your CV until you publish.
- **Tailor.** Paste or pick up the job description, press "Tailor my CV". Only the text between `% AF:BEGIN summary` ... `% AF:END summary` and `% AF:BEGIN skills` ... `% AF:END skills` is rewritten, and only with words your CV already supports (a skills line may use only words from the CV; a summary may add plain English but no new names, tools or numbers). A region that fails the check is kept as it was and the refused words are shown. You review the diff and preview, then download the PDF or attach it to the open form. If the new job description is close to an earlier one (career-ops' own `jd-similarity.mjs`), it offers that CV instead.

Tex you write by hand needs the two marker pairs to be tailorable. Tex files live in `data/cv-tex/`, tailored versions in `data/cv-tex/tailored/`.

## On a job page

The panel's "This job" card runs on demand:

- **Check this job:** blacklist (`data/blacklist.md`), earlier application (`precheck-duplicate.mjs`), posting still open (`check-liveness.mjs`), aggregator or employer site, and whether an evaluation report exists for it. A report's own drafted answers and cover letter feed the drafts here.
- **Score it:** a quick score from the local model on career-ops' five dimensions with its bands (4.5+ apply now, 4.0 worth applying, 3.5 recommend against unless you have a reason). It is labelled provisional; "Run full evaluation" queues the posting in `data/pipeline.md` for the real report.
- **Tailor my CV, Mark as applied:** applied goes through `set-status.mjs` for a known row, or a tracker-addition TSV plus `merge-tracker.mjs` for a new one, then `followup-seed.mjs`. It never edits `applications.md` directly.

Forms also get: a list of empty required fields (outlined on the page when you press Next or Submit), warnings for questions that can reject you (years of experience, degree, sponsorship), a plain-text CV for "paste your resume" boxes, and a cover letter drafted from the CV (starting from the report's draft when there is one) and attached as a PDF.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -t .
# browser end to end (real Chromium, real Ollama, throw-away database):
.venv/bin/python browser/e2e/server.py &      # prints the DB path
AF_E2E_DB=<that path> node browser/e2e/run.mjs
```

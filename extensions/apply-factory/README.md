# apply-factory

Fills job application forms from your own earlier answers and learns the ones you type. Two parts:

- `browser/` is a Chrome extension (Manifest V3) with a side panel.
- `ui/` is the source of the side panel and the CV studio: React, Tailwind and shadcn/ui, built into `browser/app` (committed, so loading the extension needs no build). After editing `ui/`, run `.venv/bin/python browser/build.py` (it runs `npm run build` in `ui/` and regenerates the manifest; `npm install` in `ui/` once first). The on-page pills and cards in `browser/content/suggest.js` use the same shadcn zinc tokens.
- `server.py` is a local API on `127.0.0.1:8765` that holds the knowledge base (`kb.sqlite`) and sends model calls to hosted models (Groq, then Gemini, using keys from `career-ops/.env`) and falls back to `claude -p`. No model runs on this Mac. Nothing beyond the question, your CV text and the job text is sent.

Your answers, details and CV files stay on this Mac. Two things are sent to a model service: a drafted answer (the question, the job text and the relevant parts of your CV) and a job score (the job text and your CV summary). They go to Groq, then Gemini, then `claude -p` if both are unavailable. The panel's You tab says the same. Without a model, saved answers still fill.

## Set up (about ten minutes, mostly waiting)

You need a Mac or a Windows PC, Google Chrome and an internet connection. Everything else is installed for you. Mac steps are below; **Windows steps are in the next section**.

1. Get the code: `git clone` this repository (or download it as a zip and unpack it), then open Terminal in the `extensions/apply-factory` folder.
2. Run one command:

   ```bash
   ./apply install
   ```

   It installs the tools Apply uses through Homebrew (if you do not have Homebrew it tells you the one line to run first), prepares the helper, installs the job search tools, starts the helper (it also starts at login) and opens Chrome's extensions page. It asks you nothing.
3. In Chrome's extensions page, turn on Developer mode, press Load unpacked and choose the `browser` folder inside `extensions/apply-factory` (the command copied its path, so Cmd+V works in the path box). Pin Apply and click it.
4. The panel's **You** tab walks you through four steps, with no files to edit:
   1. **Connect a free AI service.** Make a free key at [Groq](https://console.groq.com/keys) or [Gemini](https://aistudio.google.com/apikey) (no card), paste it, press Save. Apply checks it first. A second key, even from another account, gives you more free use per day.
   2. **Your details**: name, email, phone and the rest.
   3. **Your CV**: choose your PDF, check the text Apply reads from it.
   4. **What jobs to look for**: titles, level, country and cities, words to include or skip.
5. Open the **Jobs** tab and press **Find jobs**. The first search takes a few minutes; you can close the panel.
6. Optional: in the You tab, paste an email you wrote and a cover letter in your own LaTeX layout under **Your writing samples**. Cold emails then copy your voice, greeting and sign-off, and cover letters keep your layout exactly (only the body, recipient, date and subject change). They are stored in `data/style/` on your Mac and never shared.

After an update, run `./apply restart` and reload the extension at chrome://extensions.

Other commands: `./apply doctor` (what is ready), `./apply start | stop | status`, `./apply scan` (search from the terminal), `./apply update` (latest version), `./apply reset-pair` (let another Chrome profile use the helper), and `--dry-run` after any of them to see what it would do.

What the setup writes, all on your Mac and none of it shared: `career-ops/.env` (your keys, owner-only permissions), `facts.yml` (your details), `cv.md` (your CV text), `config/profile.yml` and `portals.yml` (made from your search answers, backed up before a later save replaces them), `data/pipeline.user.yml` (the job filters for your search; delete it to go back to the shared `config/pipeline.yml`) and `config.local.yaml` (this computer's settings). A `profile.yml` you wrote by hand is never replaced.

Without the helper, a model key or a CV, the extension still loads and the panel says what is missing. Gmail drafts in the Company tab are optional and need a one-time Google Cloud setup (see below); skip it unless you want them.

## Set up on Windows

Written for Windows 10 or 11. **This path has not been tested on a Windows machine yet** (the helper and its tests run on macOS), so if a step fails, the message it prints says what to do, and an issue report with that message helps.

1. Get the code: `git clone` this repository (install Git from https://git-scm.com first if you do not have it), or download it as a zip and unpack it. Open PowerShell or Command Prompt in the `extensions\apply-factory` folder (in File Explorer, open the folder, click the address bar, type `cmd` and press Enter).
2. Run one command:

   ```bat
   apply.cmd install
   ```

   It installs Python and Node.js through `winget` (built into current Windows) if you do not have them, prepares the helper, installs the job search tools, starts the helper (it also starts when you log in, through a small script in your Startup folder) and opens Chrome's extensions page. It asks you nothing. If Windows asks whether `winget` may install something, say yes.
3. In Chrome's extensions page, turn on Developer mode, press Load unpacked and choose the `browser` folder inside `extensions\apply-factory` (the command copied its path, so Ctrl+V works in the folder box). Pin Apply and click it.
4. Follow steps 4 to 6 of the Mac setup above: the **You** tab asks for a free AI key, your details, your CV and what jobs to look for, then the **Jobs** tab has the **Find jobs** button.

Other commands: `apply.cmd doctor`, `apply.cmd start`, `apply.cmd stop`, `apply.cmd restart`, `apply.cmd status`, `apply.cmd scan`, `apply.cmd update`, `apply.cmd reset-pair`, and `-DryRun` after any of them to see what it would do.

Two optional tools are installed with [Scoop](https://scoop.sh) (`scoop install poppler tectonic`) instead of winget: `poppler` reads the text of your CV PDF (without it, paste your CV text in the wizard) and `tectonic` builds tailored CV and cover letter PDFs. The install command does this for you when Scoop is already there, and otherwise tells you. If PowerShell refuses to run scripts, use `apply.cmd` (it allows `apply.ps1` for that one run) rather than changing a system setting.

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

## The You tab

The four-step setup (model key, details, CV, job search; each step reopens to change an answer; details are written into `facts.yml` in place, comments kept), the saved answers learned so far (search, fix, forget), CV files, behaviour switches (fill on open, open Apply on the page; both fill by default, the page panel is off by default), a local weekly total of fills and drafts, "Usage counts" (the daily anonymous report and Copy my stats, below), and what leaves your Mac. After a fill, "Undo the last fill" in the Page tab puts back what the boxes held. After a Submit-style click the panel asks whether to mark the job as applied.

## Site modes

Per site, from the side panel: Off, Watch (learns, fills nothing) or Fill. LinkedIn, Naukri and Indeed default to Watch, Glassdoor to Off; every other site defaults to Fill. Sites outside the list are read only when the page looks like an application (a form with several application questions, or an address that reads like one); the content script is loaded on every https page but stays inert otherwise, which is why Chrome lists access to all sites. Turn a site off from the panel's mode switch. The list lives in `rules/rules.json`; after editing it run `.venv/bin/python browser/build.py` to regenerate `browser/manifest.json`.

## CV studio

Open it from the panel ("Open CV studio") or from "Tailor my CV". It runs in a browser tab and has three views.

- **Edit.** Your CV as tex on the left, the compiled pages on the right. It recompiles a second after you stop typing; compile errors list with their line numbers, "Fix with AI" asks the local model to repair them, and "Publish" compiles and then replaces the PDF in `output/resumes/` (the default, DevOps or AI slot). A failed compile never replaces a working PDF. The previous tex is kept as `<slot>.previous.tex`.
- **Import PDF.** The local model reads the PDF text into structured fields, a template writes the tex, tectonic compiles it, and compile errors go back to the model for up to three fixes. You see your original beside the compiled result, and every piece of text the model returned that is not in the PDF is listed. Nothing replaces your CV until you publish.
- **Tailor.** Paste or pick up the job description, press "Tailor my CV". Only the text between `% AF:BEGIN summary` ... `% AF:END summary` and `% AF:BEGIN skills` ... `% AF:END skills` is rewritten, and only with words your CV already supports (a skills line may use only words from the CV; a summary may add plain English but no new names, tools or numbers). A region that fails the check is kept as it was and the refused words are shown. You review the diff and preview, then download the PDF or attach it to the open form. If the new job description is close to an earlier one (career-ops' own `jd-similarity.mjs`), it offers that CV instead.

Tex you write by hand needs the two marker pairs to be tailorable. Tex files live in `data/cv-tex/`, tailored versions in `data/cv-tex/tailored/`.

## On a job page

The panel's "This job" card runs on demand:

- **Check this job:** blacklist (`data/blacklist.md`), earlier application (`precheck-duplicate.mjs`), posting still open (`check-liveness.mjs`), aggregator or employer site, and whether an evaluation report exists for it. A report's own drafted answers and cover letter feed the drafts here.
- **Score it:** a quick score from the local model on career-ops' five dimensions with its bands (4.0 or more with a strong CV match is Apply, between 3.5 and 4.0 is Tailor first, below 3.5 or any broken rule of yours is Skip). It is labelled provisional; "Run full evaluation" queues the posting in `data/pipeline.md` for the real report.
- **Tailor my CV, Mark as applied:** applied goes through `set-status.mjs` for a known row, or a tracker-addition TSV plus `merge-tracker.mjs` for a new one, then `followup-seed.mjs`. It never edits `applications.md` directly.

Forms also get: a list of empty required fields (outlined on the page when you press Next or Submit), warnings for questions that can reject you (years of experience, degree, sponsorship), a plain-text CV for "paste your resume" boxes, and a cover letter drafted from the CV (starting from the report's draft when there is one) and attached as a PDF.

## Jobs and Company tabs

- **Jobs** reads the scanner's `data/jobs.db`: search, filter by source and age, open a job, mark it applied, saved or not interested. "Only jobs that fit my level" is on by default and hides senior titles, jobs outside India and jobs whose own text asks for more years than `candidate.years_of_experience` in `config/profile.yml` plus `jobs.stretch_years` (`config.yaml`). The years come from the posting's text, read in the background with career-ops' own `jd-years.mjs` over the ATS public APIs (no model, no tokens) and kept in `kb.sqlite`. A location counts as a mismatch only when it clearly names a foreign country, US state or well-known foreign city and nothing Indian (`tools/foreign-locations.mjs`); unknown places stay. When a check ends, with `jobs.auto_remove: true` (off by default, so the Jobs tab only hides them), jobs that clearly do not match (senior title, too many years, outside India) are **deleted from `jobs.db`**: a backup is saved first, their URLs go into `seen` so the scanner does not re-add them as new, the reason is logged in `rejected`, and jobs you marked or the scanner marked interested or applied are never removed. `experience_filter` in `portals.yml` drops the same jobs at scan time. The small red button on each job (press twice to confirm) puts its company on the **blacklist**, for ghost or repeated listings: its jobs are deleted from `jobs.db` (not ones you marked) and the company is added to career-ops' own `data/blacklist.md`, which every Node scanner already honours and which `tools/freshness.py` now applies to everything `mine.py` saves (`freshness.drop_blacklisted`). The Blacklist button opens an editor to fix a name or reason or take a company off; taking one off forgets the tombstones so its jobs can return on the next scan. You can also edit the file by hand.
- **Company** researches the company of the open page (or one you type). Size, then the people who matter at that size (the hiring team for the job, HR and recruiters in the job's city or in Bangalore, Hyderabad and Gurugram, then the roles for the size), each with the page that names them. Search order: Groq browser search, Gemini, then `claude -p` (haiku). Public emails and phones come from a few pages of the company's own site (robots.txt honoured).
- **Email guessing.** It first finds the real work-email domain (it can differ from the website, `gs.com` against `goldmansachs.com`) and, where a page shows real employee addresses, the company's pattern, including user names cut to 8, 7 or 6 characters. It then tries every common shape (first, last, first.last, last.first, flast, lastf, f.last, first.l, underscore and hyphen forms) and asks the mail server over SMTP (`RCPT TO`, never `DATA`) with a random-address control to spot catch-all servers. Bounce and spam bands are rule-of-thumb estimates, shown with their reasons. Port 25 must be reachable from your network; probes are capped and spaced (`mail:` in `config.yaml`).
- **Cold email.** "Draft email" on a person writes under 90 words from your CV and the job (same banned-phrase and invented-number checks as form answers) and, with Gmail connected, creates a Gmail draft with your CV and a cover letter attached. Nothing is ever sent; you press Send in Gmail. **Draft cover letter** writes a letter as LaTeX from the job's text (it names the two or three things the job asks for and answers each with a fact from your CV, addressed to the person), shows it for editing, compiles it with tectonic into a page preview, and can repair compile errors with AI. The letter that is attached is exactly the tex you reviewed; if you skip it, one is written when the draft is made. Each draft is noted in `data/contacts.tsv` with a follow-up date four business days out. Without Gmail connected, "Open in Gmail" opens a pre-filled compose window without attachments.
- **Connect Gmail once.** In Google Cloud: enable the Gmail API, create an OAuth client of type Desktop app, save its JSON as `data/gmail-credentials.json`, add yourself as a test user (or publish the app unverified so sign-in does not expire after 7 days) and press Connect Gmail in the You tab (Email drafts). The only scope is `gmail.compose` and the only Gmail call is `drafts.create`. Credentials and tokens stay in `data/` (gitignored).

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -t .
# browser end to end (real Chromium, real models, throw-away database):
.venv/bin/python browser/e2e/server.py &      # prints the DB path
AF_E2E_DB=<that path> node browser/e2e/run.mjs
```

## Seeing how people use it

- **Daily anonymous report.** `share.url` in `config.yaml` is the receiving address, set once by you so every install has it already; nobody enters it. `tools/share-receiver.gs` is a ready Google Apps Script that appends each report to a Sheet, keeps each install's latest failure counts in an Errors tab, and builds a Dashboard tab with a "What breaks most" table (setup steps are in its first lines). With an address set, the helper sends one report a day with no button to press. With it empty, nothing is sent. The report is counts only: a random install id, app version, operating system, setup steps finished, and forms, answers and drafts for 7 days, 30 days and all time, plus the number of days used in the last 30, and what failed in the last 7 days: the name of the action (such as `/outreach/gmail`) and a fixed category (`model_rate_limited`, `model_bad_key`, `model_unavailable`, `gmail_not_connected`, `gmail_not_set_up`, `gmail_error`, `latex_missing`, `timeout`, `bad_request`, `crash` or `other`) with a count. The category is chosen from the kind of error and a few keywords; the error message itself is never stored or sent. Typing a bad email in the setup wizard does not count as a failure. It never holds names, emails, CV text, answers, companies, job links or keys. The You tab, under Usage counts, says this and shows the exact report. Someone who does not want it adds `share: {enabled: false}` to their `config.local.yaml`. The install id lives in `data/share.json`; delete the file to reset it.
- **Copy my stats.** The same card has a button that copies a short text summary for someone to paste to you. The app sends nothing for that.

Tell people what you collect before you share the repo. The code is open, so it has to match what you say.

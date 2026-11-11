import { useCallback, useEffect, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api, toBase64 } from "@/lib/chrome"
import { goTab } from "./cards"
import { Details, Hint } from "./forms"
import type { Panel } from "./usePanel"

// One step: a numbered row that opens to its form. A finished step shows a check and can be reopened to change the answer.
function Step({ n, title, why, done, open, onToggle, children }: { n: number; title: string; why: string; done: boolean; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t first:border-t-0">
      <button className="flex w-full items-center gap-3 py-3 text-left" onClick={onToggle} aria-expanded={open}>
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${done ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {!open && !done && <span className="block text-xs text-muted-foreground">{why}</span>}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="space-y-3 pb-4 pl-9">{children}</div>}
    </div>
  )
}

type KeyInfo = { label: string; link: string; count: number; max: number; keys: { name: string; tail: string }[] }

function KeyStep({ onChange }: { onChange: () => void }) {
  const [keys, setKeys] = useState<Record<string, KeyInfo>>({})
  const [pick, setPick] = useState("")
  const [val, setVal] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const load = useCallback(async () => { const r = await api("/setup/state", {}); if (!r.error) { setKeys(r.keys); setPick((p) => p || Object.keys(r.keys)[0] || "") } }, [])
  useEffect(() => { load() }, [load])
  const k = keys[pick]
  if (!k) return <Hint>Loading.</Hint>
  const save = async () => {
    setBusy(true); setNote("")
    const r = await api("/setup/key", { provider: pick, key: val })
    setBusy(false)
    if (r.error) { setNote(r.error); return }
    setKeys(r.keys); setVal(""); setNote(r.added ? "Saved. It works." : "You already added that one."); onChange()
  }
  const remove = async (name: string) => {
    const r = await api("/setup/key_remove", { provider: pick, name })
    if (r.error) { setNote(r.error); return }
    setKeys(r.keys); setNote(""); onChange()
  }
  const full = k.count >= k.max
  return (
    <>
      <Hint>Apply writes drafts and scores jobs with a free AI service. One key is enough. It costs nothing and asks for no card. Keys stay on this Mac.</Hint>
      <div className="flex gap-1.5" role="radiogroup" aria-label="AI service">
        {Object.entries(keys).map(([id, v]) => (
          <Button key={id} size="sm" variant={pick === id ? "default" : "outline"} role="radio" aria-checked={pick === id} onClick={() => { setPick(id); setNote(""); setVal("") }}>{v.label} <span className="tabular-nums opacity-70">{v.count}</span></Button>
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{k.label} keys: {k.count} of {k.max}</span>
          <a href={k.link} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">Get a free key</a>
        </div>
        {k.keys.map((x) => (
          <div key={x.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-mono text-muted-foreground">Key ending {x.tail}</span>
            <button className="text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive" onClick={() => remove(x.name)} aria-label={`Remove the key ending ${x.tail}`}>Remove</button>
          </div>
        ))}
        {!full && (
          <div className="flex gap-2">
            <Input type="password" autoComplete="off" spellCheck={false} placeholder={k.count ? `+ Add another ${k.label} key` : `Paste your ${k.label} key`} aria-label={`${k.label} key`} value={val} onChange={(e) => { setVal(e.target.value); setNote("") }} />
            <Button size="sm" disabled={!val.trim() || busy} onClick={save}>{busy ? "Checking" : "Save"}</Button>
          </div>
        )}
        {full && <Hint>That is the most {k.label} keys Apply uses. Remove one to add another.</Hint>}
        {note && <Hint warn={!/^(Saved|You already)/.test(note)}>{note}</Hint>}
      </div>
      <Hint>Each key has its own free daily limit, so more keys, even from other accounts, mean more drafts and searches before a limit is reached. Apply switches to the next key by itself.</Hint>
    </>
  )
}

function CvStep({ onChange }: { onChange: () => void }) {
  const [text, setText] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [pdfNote, setPdfNote] = useState("")
  useEffect(() => { api("/setup/cv_text", {}).then((r) => { if (!r.error) setText(r.text || "") }) }, [])
  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true); setPdfNote(""); setNote("")
    const r = await api("/setup/cv", { base64: await toBase64(file) })
    setBusy(false)
    if (r.error) { setPdfNote(r.error); return }
    setPdfNote(`Saved ${r.file}.`)
    if (r.text && (!text || confirm("Replace the CV text below with the text from this PDF?"))) setText(r.text)
    else if (!r.text) setNote("This PDF has no readable text (it may be a scan). Paste your CV text below instead.")
    onChange()
  }
  const save = async () => {
    setNote("")
    const r = await api("/setup/cv_text", { text })
    setNote(r.error ? r.error : "Saved.")
    if (!r.error) onChange()
  }
  return (
    <>
      <Hint>Add your CV as a PDF. Apply attaches it to forms and reads the text from it. Check that the text below is right, because every draft and score is written from it.</Hint>
      <label className="block">
        <input type="file" accept="application/pdf" className="sr-only" aria-label="Choose your CV as a PDF" onChange={(e) => upload(e.target.files?.[0])} />
        <Button size="sm" variant="outline" asChild><span>{busy ? "Reading" : "Choose your CV PDF"}</span></Button>
      </label>
      {pdfNote && <Hint warn={!pdfNote.startsWith("Saved")}>{pdfNote}</Hint>}
      <Textarea rows={10} aria-label="Your CV as text" placeholder="Your CV as plain text" value={text} onChange={(e) => { setText(e.target.value); setNote("") }} />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={text.trim().length < 80} onClick={save}>Save CV text</Button>
        {note && <Hint warn={note !== "Saved."}>{note}</Hint>}
      </div>
    </>
  )
}

const LEVELS: [string, string][] = [["student", "Student or new graduate"], ["entry", "Early career, 0 to 2 years"], ["mid", "Mid level, 3 to 6 years"], ["senior", "Senior, 7 or more years"]]

function SearchStep({ onChange }: { onChange: () => void }) {
  const [v, setV] = useState({ roles: "", level: "", country: "", cities: "", years: "", avoid: "", keywords: "" })
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api("/setup/search", {}).then((r) => {
      if (r.error || !r.saved) return
      setV((x) => ({ ...x, roles: (r.roles || []).join(", "), level: r.level || "", country: r.country || "", cities: (r.cities || []).join(", "), years: String(r.years ?? ""), avoid: (r.avoid || []).join(", ") }))
    })
  }, [])
  const [sug, setSug] = useState<{ titles: string[]; keywords: string[] } | null>(null)
  const [sugBusy, setSugBusy] = useState(false)
  const [sugNote, setSugNote] = useState("")
  const suggest = async () => {
    setSugBusy(true); setSugNote(""); setSug(null)
    const r = await api("/setup/suggest_roles", { roles: v.roles, level: v.level, country: v.country })
    setSugBusy(false)
    if (r.error) { setSugNote(r.detail ? `${r.error}: ${r.detail}` : String(r.error)); return }
    setSug(r)
  }
  const addTitle = (t: string) => { setNote(""); setV((x) => ({ ...x, roles: x.roles.trim() ? `${x.roles.replace(/[,\s]+$/, "")}, ${t}` : t })); setSug((s) => s && { ...s, titles: s.titles.filter((y) => y !== t) }) }
  const addWord = (t: string) => { setNote(""); setV((x) => ({ ...x, keywords: x.keywords.trim() ? `${x.keywords.replace(/[,\s]+$/, "")}, ${t}` : t })); setSug((s) => s && { ...s, keywords: s.keywords.filter((y) => y !== t) }) }
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => { setNote(""); setV((x) => ({ ...x, [k]: e.target.value })) }
  const save = async () => {
    setBusy(true); setNote("")
    const r = await api("/setup/search", { values: v })
    setBusy(false)
    if (r.error) { setNote(r.error); return }
    setNote(r.notes?.length ? `Saved. ${r.notes.join(" ")}` : "Saved.")
    onChange()
  }
  return (
    <>
      <Hint>This decides which jobs the Jobs tab looks for and which it hides.</Hint>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Job titles you want, separated by commas</span>
        <Input value={v.roles} onChange={set("roles")} placeholder="Data analyst, business analyst" /></label>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={!v.roles.trim() || sugBusy} onClick={suggest}>{sugBusy ? "Thinking" : "Suggest more titles"}</Button>
          <span className="text-xs text-muted-foreground">More titles mean a wider search.</span>
        </div>
        {sugNote && <Hint warn>{sugNote}</Hint>}
        {sug && sug.titles.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Tap a title to add it</span>
              <button className="text-xs underline underline-offset-2" onClick={() => sug.titles.forEach(addTitle)}>Add all</button></div>
            <div className="flex flex-wrap gap-1.5">{sug.titles.map((t) => <Button key={t} size="xs" variant="outline" className="rounded-full" onClick={() => addTitle(t)}>+ {t}</Button>)}</div>
          </div>
        )}
        {sug && sug.keywords.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Words that often appear in these titles</span>
            <div className="flex flex-wrap gap-1.5">{sug.keywords.map((t) => <Button key={t} size="xs" variant="outline" className="rounded-full" onClick={() => addWord(t)}>+ {t}</Button>)}</div>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Your level</span>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Your level">
          {LEVELS.map(([key, label]) => (
            <Button key={key} size="sm" variant={v.level === key ? "default" : "outline"} className="justify-start" role="radio" aria-checked={v.level === key} onClick={() => { setNote(""); setV((x) => ({ ...x, level: key })) }}>{label}</Button>
          ))}
        </div>
      </div>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Years of work experience</span>
        <Input inputMode="decimal" value={v.years} onChange={set("years")} placeholder="0" /></label>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Country to search in</span>
        <Input value={v.country} onChange={set("country")} placeholder="United States" /></label>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Cities (optional)</span>
        <Input value={v.cities} onChange={set("cities")} placeholder="Austin, Remote" /></label>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Other words in a job title that you want (optional)</span>
        <Input value={v.keywords} onChange={set("keywords")} placeholder="sql, tableau" /></label>
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">Words in a job title to skip (optional)</span>
        <Input value={v.avoid} onChange={set("avoid")} placeholder="sales, intern" /></label>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving" : "Save"}</Button>
        {note && <Hint warn={!note.startsWith("Saved")}>{note}</Hint>}
      </div>
    </>
  )
}

export function SetupWizard({ p }: { p: Panel }) {
  const setup = p.st?.server?.setup
  const [open, setOpen] = useState<string>("")
  const steps: any[] = setup?.steps || []
  // The CV has two checks (the PDF and its text) but one place to do them.
  const rows = [
    { key: "model", n: 1, title: "Connect a free AI service", why: "Writes answers, scores jobs, researches companies.", done: !!steps.find((s) => s.key === "model")?.done },
    { key: "details", n: 2, title: "Your details", why: "Name, email and phone fill most forms.", done: !!steps.find((s) => s.key === "details")?.done },
    { key: "cv", n: 3, title: "Your CV", why: "Attached to forms and used for drafts.", done: !!steps.find((s) => s.key === "cv_pdf")?.done && !!steps.find((s) => s.key === "cv_text")?.done },
    { key: "search", n: 4, title: "What jobs to look for", why: "Roles, level and place for the Jobs tab.", done: !!steps.find((s) => s.key === "search")?.done },
  ]
  const next = rows.find((r) => !r.done)?.key || ""
  useEffect(() => { setOpen((o) => o || next) }, [next])
  if (!setup) return null
  const finished = rows.filter((r) => r.done).length
  const toggle = (k: string) => setOpen((o) => (o === k ? "" : k))
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{next ? "Get started" : "Setup is complete"}</CardTitle>
        <CardDescription>{next ? `${finished} of ${rows.length} done. This takes about five minutes.` : "Forms fill, drafts are written, and the Jobs tab knows what to look for."}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.map((r) => (
          <Step key={r.key} n={r.n} title={r.title} why={r.why} done={r.done} open={open === r.key} onToggle={() => toggle(r.key)}>
            {r.key === "model" && <KeyStep onChange={p.refresh} />}
            {r.key === "details" && <Details p={p} />}
            {r.key === "cv" && <CvStep onChange={p.refresh} />}
            {r.key === "search" && <SearchStep onChange={p.refresh} />}
          </Step>
        ))}
        {!next && <div className="pt-3"><Button size="sm" onClick={() => goTab("jobs")}>Find jobs</Button></div>}
      </CardContent>
    </Card>
  )
}

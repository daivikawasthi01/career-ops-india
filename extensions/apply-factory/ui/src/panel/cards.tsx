import { useEffect, useState } from "react"
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { toBase64 } from "@/lib/chrome"
import type { Panel } from "./usePanel"

const SOURCE: Record<string, string> = { fact: "From your profile", kb: "Your earlier answer", similar: "Matched a similar question", draft: "Drafted from your CV", user: "Typed by you", report: "From your evaluation of this job" }
const MODES: [string, string][] = [["off", "Off"], ["watch", "Watch"], ["assist", "Fill"]]
const MODE_NOTE: Record<string, string> = { off: "Not reading this site.", watch: "Learns what you type. Fills nothing.", assist: "Fills your saved answers and learns what you type." }

export const framesItems = (st: any) => Object.entries(st.frames || {}).flatMap(([frameId, f]: [string, any]) => (f.items || []).map((i: any) => ({ ...i, frameId })))
const llmOk = (st: any) => !!st.server?.llm?.ok
export const goTab = (tab: string) => window.dispatchEvent(new CustomEvent("af-goto", { detail: tab }))
const GUARDED = /(^|\.)(linkedin|naukri|indeed|glassdoor)\./

const toneClass = (tone: string) =>
  tone === "ok" ? "border-success/30 bg-success/10 text-success" : tone === "stop" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning/10 text-warning"
const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(1) : "?")

function Hint({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <p className={`text-xs leading-relaxed ${warn ? "text-warning" : "text-muted-foreground"}`}>{children}</p>
}

// ---- site mode ----
export function SiteCard({ p }: { p: Panel }) {
  const { st, send, refresh, siteNote, setSiteNote, tabId } = p
  const idle = !st.injected && st.siteMode !== "off"
  const watchTab = async () => {
    setSiteNote("")
    const res = await send("watch-tab")
    if (res?.error) setSiteNote(`Chrome would not let the extension in: ${res.error}. Click the Apply icon on this tab and try again, or use "Always on for this site".`)
    setTimeout(refresh, 1500)
  }
  const enableSite = async () => {
    setSiteNote("")
    let granted = false
    try { granted = await chrome.permissions.request({ origins: [`https://${st.host}/*`] }) } catch (e: any) { setSiteNote(`Chrome refused the request: ${e.message}`) }
    if (!granted) { setSiteNote((n) => n || `Access to ${st.host} was not granted, so nothing was changed.`); return }
    const res = await send("enable-site", { host: st.host })
    if (res?.error) { setSiteNote(`Could not turn it on: ${res.error}`); return }
    if (tabId != null) await chrome.tabs.reload(tabId)
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{st.host}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={st.siteMode} onValueChange={async (mode) => { await send("set-mode", { host: st.host, mode }); refresh() }}>
          <TabsList className="w-full" aria-label="Mode for this site">
            {MODES.map(([value, name]) => <TabsTrigger key={value} value={value} role="radio" aria-checked={st.siteMode === value}>{name}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <Hint>{idle ? "Not active on this site yet." : MODE_NOTE[st.siteMode]}</Hint>
        {GUARDED.test(st.host || "") && st.siteMode !== "assist" && <Hint>{st.siteMode === "off" ? "Off here by default." : "Watch is the default here: these sites limit automation, so Apply only learns."} Choose Fill if you want answers filled on this site.</Hint>}
        {idle && st.host && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={watchTab}>Watch this tab</Button>
            <Button size="sm" variant="outline" onClick={enableSite}>Always on for this site</Button>
          </div>
        )}
        {siteNote && <Hint warn>{siteNote}</Hint>}
        {st.granted && <Button size="sm" variant="outline" onClick={async () => { await send("disable-site", { host: st.host }); refresh() }}>Turn off for this site</Button>}
      </CardContent>
    </Card>
  )
}

// ---- how far the page is ----
export function SummaryCard({ p, all }: { p: Panel; all: any[] }) {
  const { st, send } = p
  const fillable = all.filter((i) => i.status === "fill" || i.status === "resume")
  const filled = fillable.filter((i) => i.filled).length
  const drafts = all.filter((i) => ["draftable", "drafting", "draft"].includes(i.status))
  const ready = drafts.filter((i) => i.status === "draft").length
  const writing = drafts.filter((i) => i.status === "drafting").length
  const draftable = all.filter((i) => i.status === "draftable").length
  const undo = (Object.values(st.frames || {}) as any[]).reduce((n, f) => n + (f.undo || 0), 0)
  const allFilled = fillable.length > 0 && filled === fillable.length
  const why = !fillable.length ? "No saved answers match this page yet. Answer it by hand and Apply learns it." : allFilled ? "All saved answers are filled." : ""
  const draftWhy = !draftable ? "" : !llmOk(st) ? "Drafting needs a model. See the You tab." : ""
  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">{filled}</span>
          <span className="text-sm text-muted-foreground">{fillable.length ? `of ${fillable.length} saved answers filled` : "saved answers on this page"}</span>
          {fillable.length > 0 && filled === fillable.length && <Badge variant="outline" className={toneClass("ok")}><Check className="size-3" />Done</Badge>}
        </div>
        {drafts.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">{writing > 0 && <Loader2 className="size-3 animate-spin" />}Suggestions ready</span>
              <span className="tabular-nums">{ready} of {drafts.length}</span>
            </div>
            <Progress value={(ready / drafts.length) * 100} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={!fillable.length || allFilled} onClick={() => send("fill-known")}>Fill answers</Button>
          <Button variant="outline" disabled={!draftable || !llmOk(st)} onClick={() => send("draft-all")}>Draft the rest</Button>
        </div>
        {(why || draftWhy) && <Hint>{[why, draftWhy].filter(Boolean).join(" ")}</Hint>}
        {undo > 0 && <Button size="xs" variant="ghost" onClick={() => send("undo-fill")}>Undo the last fill ({undo})</Button>}
      </CardContent>
    </Card>
  )
}

// ---- one field ----
function FieldHead({ p, i, badge }: { p: Panel; i: any; badge?: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <button className="text-left text-sm font-medium leading-snug hover:underline" title="Show on the page" onClick={() => p.send("focus", { id: i.id })}>{i.label}</button>
      {badge && <Badge variant="secondary" className="shrink-0 text-xs font-normal">{badge}</Badge>}
    </div>
  )
}

export function FilledCard({ p, i }: { p: Panel; i: any }) {
  const isResume = i.status === "resume"
  const src = [SOURCE[i.source], i.note && i.source === "similar" ? `"${i.note}"` : ""].filter(Boolean).join(": ")
  return (
    <Card size="sm" data-field={i.id}>
      <CardContent className="space-y-2">
        <FieldHead p={p} i={i} badge={isResume ? i.note || "Your CV" : src} />
        {isResume && i.filled && <p className="text-sm">{i.value}</p>}
        {!isResume && <Input key={`${i.id}:${i.value ?? ""}`} defaultValue={i.value ?? ""} aria-label={i.label} onBlur={(e) => { if (e.target.value !== (i.value ?? "")) p.send("fill-one", { id: i.id, value: e.target.value, source: "user" }) }} />}
        {i.reason && <Hint>{i.reason}</Hint>}
        {!i.filled && <Button size="xs" variant="outline" onClick={() => p.send("fill-one", { id: i.id, value: i.value, source: i.source })}>Fill</Button>}
      </CardContent>
    </Card>
  )
}

// A cover-letter row has its own card. The split keeps the hooks of each card unconditional: a field whose status flips to "cover" and back
// used to change the number of hooks in one component, which React rejects.
export function NeedsCard(props: { p: Panel; i: any; drafts: Record<string, string> }) {
  return props.i.status === "cover" ? <CoverCard p={props.p} i={props.i} /> : <FieldCard {...props} />
}

function FieldCard({ p, i, drafts }: { p: Panel; i: any; drafts: Record<string, string> }) {
  const { st, send } = p
  const [text, setText] = useState<string | null>(null)
  const edited = text ?? drafts[i.id] ?? i.value ?? ""
  return (
    <Card size="sm" data-field={i.id}>
      <CardContent className="space-y-2">
        <FieldHead p={p} i={i} badge={i.status === "draft" ? SOURCE.draft : undefined} />
        {i.status === "draftable" && <>
          <Hint>{i.hint ? `You have "${i.hint}" saved, but no option matches it.` : "No saved answer yet."}</Hint>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" disabled={!llmOk(st)} onClick={() => send("draft", { id: i.id })}>Draft</Button>
            {!llmOk(st) && <button className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => goTab("you")}>How to add a model</button>}
          </div>
        </>}
        {i.status === "drafting" && <Hint><Loader2 className="mr-1 inline size-3 animate-spin" />Writing.</Hint>}
        {i.status === "draft" && <>
          <Textarea className="max-h-56 overflow-auto" aria-label={i.label} rows={5} value={edited} onChange={(e) => { setText(e.target.value); drafts[i.id] = e.target.value }} />
          <div className="flex gap-2">
            <Button size="xs" onClick={() => send("fill-one", { id: i.id, value: drafts[i.id] ?? i.value, source: "draft" })}>Insert answer</Button>
            <Button size="xs" variant="outline" onClick={() => send("draft", { id: i.id })}>Draft again</Button>
          </div>
        </>}
        {i.status === "unknown" && <Hint>{i.reason?.includes("CV") ? i.reason : "New question. Answer it on the page and I learn it."}</Hint>}
        {i.status === "manual" && <Hint>{i.reason || "Yours to answer."}</Hint>}
        {i.status === "offline" && <Hint>{i.reason || "Server offline."}</Hint>}
      </CardContent>
    </Card>
  )
}

function CoverCard({ p, i }: { p: Panel; i: any }) {
  const { st, covers, setCovers, callApi, send, jobContext } = p
  const c = covers[i.id] || {}
  const set = (v: any) => setCovers((all) => ({ ...all, [i.id]: { ...(all[i.id] || {}), ...v } }))
  const draft = async () => {
    set({ busy: true })
    const ctx = await jobContext()
    const res = await callApi("/cover", { url: ctx.url, title: ctx.title, company: ctx.company, jd_text: ctx.jd_text })
    setCovers((all) => ({ ...all, [i.id]: res.error ? { ...(all[i.id] || {}), busy: false, error: res.error } : { text: res.text, fromReport: res.from_report } }))
  }
  const attach = async () => {
    set({ error: "", done: "" })
    const ctx = await jobContext()
    const pdf = await callApi("/cover/pdf", { text: c.text, company: ctx.company, title: ctx.title })
    if (pdf.error) { set({ error: pdf.error }); return }
    const res = await send("attach-file", { kind: "cover", name: pdf.name, base64: pdf.base64 })
    set({ done: res?.error ? res.error : `Attached ${pdf.name}.` })
  }
  return (
    <Card size="sm" data-field={i.id}>
      <CardContent className="space-y-2">
        <FieldHead p={p} i={i} />
        {!c.text && <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" disabled={c.busy || !llmOk(st)} onClick={draft}>{c.busy ? "Writing" : "Draft cover letter"}</Button>
          {!llmOk(st) && <button className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => goTab("you")}>How to add a model</button>}
        </div>}
        {c.text && <>
          <Textarea aria-label="Cover letter" rows={8} value={c.text} onChange={(e) => set({ text: e.target.value, done: "" })} />
          <div className="flex gap-2">
            <Button size="xs" onClick={attach}>Attach as PDF</Button>
            <Button size="xs" variant="outline" onClick={draft}>Draft again</Button>
          </div>
        </>}
        {c.text?.includes("**") && <Hint>Words between double stars are bold in the PDF.</Hint>}
        {c.fromReport && <Hint>Started from the draft in your evaluation report.</Hint>}
        {c.error && <Hint warn>{c.error}</Hint>}
        {c.done && <Hint>{c.done}</Hint>}
      </CardContent>
    </Card>
  )
}

export function Group({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (!children.length) return null
  return (
    <section className="space-y-2">
      <h2 className="section-label">{title} <span className="tabular-nums">{children.length}</span></h2>
      {children}
    </section>
  )
}

export function AttentionCards({ p }: { p: Panel }) {
  const frames = Object.values(p.st.frames || {}) as any[]
  const missing = frames.flatMap((f) => f.missing || [])
  const warns = frames.flatMap((f) => f.warnings || [])
  return <>
    {missing.length > 0 && (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{missing.length} required field{missing.length > 1 ? "s" : ""} empty</AlertTitle>
        <AlertDescription className="flex flex-col items-start">
          {missing.map((m: any) => <button key={m.id} className="text-left underline-offset-2 hover:underline" onClick={() => p.send("focus", { id: m.id })}>{m.label}</button>)}
        </AlertDescription>
      </Alert>
    )}
    {warns.length > 0 && (
      <Alert>
        <AlertTriangle />
        <AlertTitle>Questions that can reject you</AlertTitle>
        <AlertDescription className="space-y-1">
          {warns.map((w: any) => <div key={w.id}><button className="text-left font-medium underline-offset-2 hover:underline" onClick={() => p.send("focus", { id: w.id })}>{w.label}</button><Hint warn>{w.why}</Hint></div>)}
        </AlertDescription>
      </Alert>
    )}
  </>
}

// ---- job: score, checks, tailor, mark applied ----
function checkRows(pre: any): [string, string, string][] {
  const rows: [string, string, string][] = []
  const bl = pre.blacklist
  rows.push(bl.status === "hit" ? ["Stop", `On your do-not-apply list${bl.entry?.reason ? `: ${bl.entry.reason}` : ""}.`, "stop"]
    : bl.status === "clear" ? ["OK", "Not on your do-not-apply list.", "ok"] : ["Check", "Could not read the do-not-apply list.", "check"])
  const d = pre.duplicate
  rows.push(d.status === "found" ? ["Check", `You already have ${d.rows.length} tracker row${d.rows.length > 1 ? "s" : ""} for this company or role.`, "check"]
    : d.status === "clear" ? ["OK", "No earlier application found.", "ok"] : ["Check", "Could not check earlier applications.", "check"])
  const l = pre.liveness
  rows.push(l.status === "expired" ? ["Stop", "The posting looks closed.", "stop"] : l.status === "active" ? ["OK", "The posting looks open.", "ok"] : ["Check", "Could not confirm the posting is still open.", "check"])
  const a = pre.aggregator
  rows.push(a.status === "aggregator" ? ["Check", `${a.host} is an aggregator. Treat this role as unconfirmed until you find it on the employer's own site.`, "check"] : ["OK", "This is the employer's own site.", "ok"])
  const r = pre.report
  rows.push(r.status === "match" ? ["OK", `Evaluated before: ${r.score ?? "?"}/5 (report ${r.num}). Its answers are used for drafts.`, "ok"]
    : r.status === "company" ? ["Check", `A report exists for this company (${r.num}, ${r.score ?? "?"}/5). Make sure it is the same posting.`, "check"] : ["Check", "Not evaluated yet. Run the full evaluation for the real score.", "check"])
  return rows
}

function ScoreBlock({ p, sc }: { p: Panel; sc: any }) {
  const queue = async () => {
    const ctx = await p.jobContext()
    const res = await p.callApi("/queue", { url: ctx.url, title: ctx.title, company: ctx.company })
    p.patchJob({ result: res.error ? res.error : res.queued ? "Queued for a full evaluation. In Claude Code, in the career-ops folder, run /career-ops pipeline." : res.reason })
  }
  return (
    <div className="score space-y-2">
      <Separator />
      <p className="text-xs font-medium">{sc.verdict}</p>
      <p className="text-xs text-muted-foreground">Overall <span className="figure font-medium text-foreground tabular-nums">{fmt(sc.global)}</span> of 5</p>
      {sc.dealbreakers?.length > 0 && <Hint warn>Breaks your own rules: {sc.dealbreakers.join("; ")}</Hint>}
      {(sc.dimensions || []).map((d: any) => (
        <div key={d.name} className="dim space-y-0.5">
          <p className="flex justify-between text-xs"><span className="font-medium">{d.name}</span><span className="tabular-nums">{d.score}/5</span></p>
          {d.evidence && <Hint>{d.evidence}</Hint>}
        </div>
      ))}
      <Hint>A quick estimate from the model{sc.thin ? ", on little job text" : ""}. The full evaluation is the score that counts.</Hint>
      <Button size="xs" variant="outline" onClick={queue}>Run full evaluation</Button>
    </div>
  )
}

export function VerdictBanner({ p }: { p: Panel }) {
  const { job, send, patchJob } = p
  const sc = job.score
  if (!sc && job.busy !== "score") return null
  if (!sc) return <Card size="sm"><CardContent><Hint><Loader2 className="mr-1 inline size-3 animate-spin" />Reading this job against your CV...</Hint></CardContent></Card>
  const a = sc.action || { key: "tailor", label: "Tailor first", why: "" }
  const tone = a.key === "skip" ? "stop" : a.key === "apply" ? "ok" : "check"
  return (
    <Card size="sm" data-action={a.key}>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">{fmt(sc.global)}</span>
          <span className="text-sm text-muted-foreground">of 5, quick estimate</span>
          <Badge variant="outline" className={`ml-auto ${toneClass(tone)}`}>{a.label}</Badge>
        </div>
        <Hint>{sc.summary || a.why}</Hint>
        {job.pre?.report?.status === "match" && <Hint warn>You evaluated this job before: {fmt(job.pre.report.score)} of 5. Trust that one over this estimate.</Hint>}
        {sc.dealbreakers?.length > 0 && <Hint warn>Breaks your rules: {sc.dealbreakers.join("; ")}</Hint>}
        <div className="flex gap-2">
          {a.key === "tailor" && <Button size="xs" onClick={() => send("open-studio", { view: "tailor" })}>Tailor my CV</Button>}
          <Button size="xs" variant="outline" onClick={() => patchJob({ showScore: !job.showScore })}>Full breakdown</Button>
        </div>
        {job.showScore && <ScoreBlock p={p} sc={sc} />}
      </CardContent>
    </Card>
  )
}

export function JobCard({ p }: { p: Panel }) {
  const { st, job, patchJob, send, callApi, jobContext, runChecks, runScore } = p
  const busy = job.busy
  const markApplied = async () => {
    const ctx = await jobContext()
    const slot = (st.server?.resumes || []).find((r: any) => r.exists)
    const res = await callApi("/applied", { url: ctx.url, title: ctx.title, company: ctx.company, resume: slot?.file || "" })
    patchJob({ confirm: false, result: res.error ? res.error : res.ok ? `Tracker row ${res.num} ${res.action} as Applied. Follow-up date seeded.` : `Not saved: ${(res.steps || []).join("; ") || "no reason given"}` })
  }
  return (
    <Card size="sm">
      <CardHeader><CardTitle>This job</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={!!busy} onClick={runChecks}>{busy === "checks" ? "Checking" : "Check this job"}</Button>
          <Button variant="outline" disabled={!!busy || !llmOk(st)} onClick={() => runScore()}>{busy === "score" ? "Scoring" : "Score it"}</Button>
        </div>
        {job.error && <Hint warn>{job.error}</Hint>}
        {job.pre && (
          <ul className="checks space-y-1.5">
            {checkRows(job.pre).map(([word, text, tone], n) => (
              <li key={n} className="flex items-start gap-2 text-xs">
                <Badge variant="outline" className={`shrink-0 ${toneClass(tone)}`}>{word}</Badge><span className="pt-0.5 text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        )}
        {job.score && !job.showScore && <Hint>Scored {fmt(job.score.global)} of 5, shown at the top.</Hint>}
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => send("open-studio", { view: "tailor" })}>Tailor my CV</Button>
          <Button variant="outline" onClick={() => patchJob({ confirm: true })}>Mark as applied</Button>
        </div>
        {job.confirm && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted-foreground">Add {job.ctx?.company || "this company"} to your tracker as Applied?</p>
            <div className="flex gap-2"><Button size="xs" onClick={markApplied}>Confirm</Button><Button size="xs" variant="outline" onClick={() => patchJob({ confirm: false })}>Cancel</Button></div>
          </div>
        )}
        {job.result && <Hint>{job.result}</Hint>}
      </CardContent>
    </Card>
  )
}

// ---- setup problems ----
export function SetupCard({ p }: { p: Panel }) {
  const cmd = window.AF_SERVER_CMD || "./apply start"
  const [copied, setCopied] = useState("")
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied("Copied.") } catch { setCopied("Chrome blocked copying. Select the command and copy it by hand.") }
    setTimeout(() => setCopied(""), 2500)
  }
  const plain = p.st?.error === "server offline" || !p.st
  return (
    <Card>
      <CardHeader>
        <CardTitle>{plain ? "Start the local server" : "The server needs attention"}</CardTitle>
        <CardDescription>{plain ? "Apply keeps your answers on this Mac, so it needs a small helper program running. In Terminal, open the extensions/apply-factory folder of this project and run this. If you have not installed it yet, run ./apply install instead:" : p.st.error}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plain && <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs select-all">{cmd}</pre>}
        <div className="flex gap-2">
          {plain && <Button size="sm" variant="outline" onClick={copy}><Copy />Copy command</Button>}
          <Button size="sm" onClick={p.refresh}>Check again</Button>
        </div>
        {copied && <Hint>{copied}</Hint>}
      </CardContent>
    </Card>
  )
}

export function OldManifestCard() {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Reload the extension</AlertTitle>
      <AlertDescription>
        <p>Apply was updated, but Chrome is still running the previous version, so new features will not work yet.</p>
        <p>Open chrome://extensions, find Apply and press the reload arrow.</p>
      </AlertDescription>
    </Alert>
  )
}

export function StaleCard({ p }: { p: Panel }) {
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>This tab needs a refresh</AlertTitle>
      <AlertDescription>
        <p>The extension was updated after this page opened, so the page is still running the old version without the new features.</p>
        <Button size="xs" className="mt-2" onClick={() => chrome.tabs.reload(p.tabId!)}>Refresh this tab</Button>
      </AlertDescription>
    </Alert>
  )
}

// ---- CV files and settings ----
export function CvCard({ p }: { p: Panel }) {
  const rows = p.st.server?.resumes
  if (!rows) return null
  const replace = async (kind: string, file?: File) => {
    if (!file) return
    const res = await p.send("upload-resume", { kind, base64: await toBase64(file) })
    p.setNotice(res.error ? res.error : `Saved ${res.file}. The old one is kept as .previous.pdf.`)
    p.refresh()
  }
  return (
    <Card size="sm">
      <CardHeader><CardTitle>Your CV files</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {rows.map((r: any) => (
          <div key={r.kind} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.label}</p>
              <p className="truncate text-xs text-muted-foreground">{r.exists ? r.file : r.uses_default ? "Not added. The default CV is used." : "Not added yet."}</p>
            </div>
            <label>
              <input type="file" accept="application/pdf" className="sr-only" aria-label={`Choose a PDF for ${r.label}`} onChange={(e) => replace(r.kind, e.target.files?.[0])} />
              <Button size="xs" variant="outline" asChild><span>{r.exists ? "Replace" : "Add"}</span></Button>
            </label>
          </div>
        ))}
        <Button size="sm" onClick={() => p.send("open-studio", { view: "edit" })}>Open CV studio</Button>
        {p.notice && <Hint>{p.notice}</Hint>}
      </CardContent>
    </Card>
  )
}

// A switch that shows what the background worker holds, but answers at once. It resyncs when the stored value changes elsewhere.
export function Setting({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(value)
  useEffect(() => setOn(value), [value])
  return (
    <label className="flex items-center justify-between gap-3 text-sm">{label}
      <Switch checked={on} onCheckedChange={(v) => { setOn(v); onChange(v) }} /></label>
  )
}

export function Footer({ p }: { p: Panel }) {
  const { st, send, refresh } = p
  const c = st.server?.counts
  const llm = st.server?.llm
  return (
    <footer className="space-y-3 px-1 pb-4 pt-1">
      <Separator />
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>Version {chrome.runtime.getManifest().version}</p>
        {c && <p>{c.answers} saved answers. Manage them in the You tab.</p>}
        {c?.pending > 0 && <p>{c.pending} to learn when the model is back. <button className="underline" onClick={async () => { await send("retry"); refresh() }}>Retry now</button></p>}
        {st.server?.last_capture?.new != null && <p>Last save: {st.server.last_capture.new} new, {st.server.last_capture.reinforced} confirmed, {st.server.last_capture.corrected} changed.</p>}
        {llm && !llm.ok && <p>No model is available. Saved answers still fill; drafts need one. See the You tab.</p>}
      </div>
    </footer>
  )
}

// After a Submit-style click the page often navigates away, so the question waits in the panel instead of on the page.
export function SubmittedCard({ p }: { p: Panel }) {
  const sub = p.st.submitted
  const [note, setNote] = useState("")
  if (!sub) return null
  const mark = async () => {
    const slot = (p.st.server?.resumes || []).find((r: any) => r.exists)
    const res = await p.callApi("/applied", { url: sub.url, title: sub.title, company: sub.company, resume: slot?.file || "" })
    if (res.error || !res.ok) { setNote(res.error || `Not saved: ${(res.steps || []).join("; ") || "no reason given"}`); return }
    await p.send("dismiss-submitted"); p.refresh()
  }
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <p className="text-sm font-medium">Did you send this application?</p>
        <Hint>{sub.company || sub.title || "This page"} looked submitted. Add it to your tracker as Applied?</Hint>
        <div className="flex gap-2">
          <Button size="xs" onClick={mark}>Yes, mark as applied</Button>
          <Button size="xs" variant="outline" onClick={async () => { await p.send("dismiss-submitted"); p.refresh() }}>No</Button>
        </div>
        {note && <Hint warn>{note}</Hint>}
      </CardContent>
    </Card>
  )
}

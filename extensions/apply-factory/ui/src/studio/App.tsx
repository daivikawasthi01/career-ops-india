import { useCallback, useEffect, useRef, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { api, send as rawSend, toBase64 } from "@/lib/chrome"
import { currentTheme, toggleTheme } from "@/lib/theme"

const params = new URLSearchParams(location.hash.slice(1))
const tabId = Number(params.get("tab")) || null
const send = (type: string, extra: Record<string, any> = {}) => rawSend(type, { tabId, ...extra })

// Import, tailor and fix take minutes with a model: start the job, then poll it.
async function longApi(path: string, body: Record<string, any>) {
  const started = await api(path, body)
  if (started.error || !started.job) return started
  const until = Date.now() + 20 * 60 * 1000
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000))
    const j = await api("/cv/job", { id: started.job })
    if (j.error) return j
    if (j.status === "done") return j.result
    if (j.status === "error") return { error: j.error }
  }
  return { error: "Timed out waiting for the model." }
}

function download(name: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
  a.download = name
  document.body.append(a); a.click(); a.remove()
}

const Pages = ({ list, label }: { list: string[]; label: string }) => (
  <div className="pages space-y-3">{list.map((b, i) => <img key={i} className="w-full rounded-md border bg-white" src={`data:image/png;base64,${b}`} alt={`${label}, page ${i + 1}`} />)}</div>
)
const Note = ({ children, warn }: { children: React.ReactNode; warn?: boolean }) => <p className={`text-sm ${warn ? "text-warning" : "text-muted-foreground"}`}>{children}</p>

export function App() {
  const [view, setView] = useState(params.get("view") || "edit")
  const [slot, setSlot] = useState("default")
  const [slots, setSlots] = useState<any[]>([])
  const [tex, setTex] = useState("")
  const [meta, setMeta] = useState<any>({})
  const [errors, setErrors] = useState<any[]>([])
  const [pages, setPages] = useState<string[]>([])
  const [imp, setImp] = useState<any>(null)
  const [tailor, setTailor] = useState<any>(null)
  const [jd, setJd] = useState({ company: "", title: "", text: "" })
  const [status, setStatus] = useState<{ text: string; tone: string }>({ text: "", tone: "" })
  const [, rerender] = useState(0)
  const editor = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const say = (text: string, tone = "") => setStatus({ text, tone })
  const slotLabel = slots.find((s) => s.kind === slot)?.label || "Default CV"

  const loadSlots = useCallback(async () => {
    const res = await api("/cv/slots")
    if (res.error) { say(res.error, "warn"); return }
    setSlots(res.slots)
  }, [])

  const compile = useCallback(async (source: string) => {
    say("Compiling")
    const res = await api("/cv/compile", { tex: source })
    if (res.error) { say(res.error, "warn"); return }
    setErrors(res.errors); setPages(res.pages)
    say(res.ok ? "Compiled" : `${res.errors.length} error${res.errors.length === 1 ? "" : "s"}`, res.ok ? "ok" : "warn")
  }, [])

  const loadTex = useCallback(async (kind: string) => {
    const res = await api("/cv/tex", { kind })
    setTex(res.tex || ""); setMeta(res.meta || {}); setErrors([]); setPages([])
    if (res.tex) await compile(res.tex)
  }, [compile])

  useEffect(() => {
    (async () => {
      await loadSlots()
      if (tabId) {
        const ctx = await send("job-context")
        if (ctx && !ctx.error) setJd({ company: ctx.company || "", title: ctx.heading || ctx.title || "", text: ctx.jd_text || "" })
      }
      await loadTex("default")
    })()
  }, [loadSlots, loadTex])

  const jumpTo = (line?: number) => {
    const el = editor.current
    if (!line || !el) return
    const at = tex.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0)
    el.focus(); el.setSelectionRange(at, at + (tex.split("\n")[line - 1] || "").length)
  }

  const publish = async () => {
    if (!tex.trim()) return
    say("Compiling and publishing")
    const res = await api("/cv/publish", { kind: slot, tex })
    if (res.error) { say(res.error, "warn"); return }
    setErrors(res.errors); if (res.pages?.length) setPages(res.pages)
    if (res.published) { setMeta({ confirmed: true, source: "manual" }); say(`Published. Forms now attach this as the ${slotLabel}.`, "ok"); await loadSlots() }
    else say("Not published: fix the errors first. Your current PDF is unchanged.", "warn")
  }

  const fixWithAi = async () => {
    say("Asking the model to fix the tex. This can take a minute.")
    const res = await longApi("/cv/fix", { tex })
    if (res.error) { say(res.error, "warn"); return }
    setTex(res.tex); setErrors(res.errors); setPages(res.pages)
    say(res.ok ? `Fixed in ${res.rounds} round${res.rounds === 1 ? "" : "s"}. Check the wording before you publish.` : "Could not fix it automatically.", res.ok ? "ok" : "warn")
  }

  const runImport = async (file?: File) => {
    if (!file) return
    if (slots.find((s) => s.kind === slot)?.tex && !confirm(`This replaces the tex for the ${slotLabel}. The old tex is kept as a .previous file. Continue?`)) return
    setImp({ busy: true })
    say("The local model is reading your PDF and building the CV. This usually takes 2 to 4 minutes. You can leave this tab open and come back.")
    const res = await longApi("/cv/import", { base64: await toBase64(file), kind: slot })
    setImp(res.error ? { error: res.error } : res)
    say(res.error ? "Import failed" : "Imported. Check it, then open it in the editor.", res.error ? "warn" : "ok")
    await loadSlots()
  }

  const runTailor = async () => {
    setTailor({ busy: true })
    say("Tailoring with the model. This usually takes 1 to 2 minutes.")
    const res = await longApi("/cv/tailor", { kind: slot, jd_text: jd.text, title: jd.title, company: jd.company })
    setTailor(res.error ? { error: res.error } : res)
    say(res.error ? "Could not tailor" : "Tailored. Review the changes below.", res.error ? "warn" : "ok")
  }

  const saveTailored = async () => {
    const res = await api("/cv/tailor/save", { kind: slot, tex: tailor.tex_after, jd_text: jd.text, title: jd.title, company: jd.company })
    if (res.error || !res.ok) { say(res.error || "It did not compile", "warn"); return null }
    return res
  }

  const imported = meta.confirmed === false && meta.source === "import"

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background/90 px-4 py-2 backdrop-blur">
        <h1 className="text-base font-semibold tracking-tight">CV studio</h1>
        <Tabs value={view} onValueChange={setView}>
          <TabsList aria-label="Studio views">
            {[["edit", "Edit"], ["import", "Import PDF"], ["tailor", "Tailor"]].map(([id, name]) => <TabsTrigger key={id} value={id} role="tab">{name}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Label htmlFor="slot" className="text-xs text-muted-foreground">CV</Label>
          <Select value={slot} onValueChange={async (v) => { setSlot(v); await loadTex(v) }}>
            <SelectTrigger id="slot" size="sm" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>{slots.map((s) => <SelectItem key={s.kind} value={s.kind}>{s.label}{s.tex ? "" : " (no tex yet)"}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <span id="status" role="status" className={`ml-auto text-sm ${status.tone === "warn" ? "text-warning" : status.tone === "ok" ? "text-success" : "text-muted-foreground"}`}>{status.text}</span>
        <Button size="icon-sm" variant="ghost" id="theme" aria-label="Toggle theme" onClick={() => { toggleTheme(); rerender((n) => n + 1) }}>{currentTheme() === "dark" ? <Sun /> : <Moon />}</Button>
      </header>

      <main id="view" className="mx-auto max-w-[1400px] space-y-4 p-4">
        {view === "edit" && <>
          {imported && <Alert><AlertTitle>Imported from a PDF: check it before you publish</AlertTitle><AlertDescription>The local model read your PDF and a template wrote this tex. Compare the preview with your original, fix anything wrong, then publish.</AlertDescription></Alert>}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Tex source</CardTitle>
                {!tex && !meta.source && <CardDescription>No tex for this CV yet. Paste yours here, or use Import PDF. To allow tailoring, wrap the summary and skills text in "% AF:BEGIN summary" ... "% AF:END summary" and the same for skills.</CardDescription>}
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea ref={editor} className="tex h-[60vh] font-mono text-xs" spellCheck={false} aria-label="CV tex source" value={tex}
                  onChange={(e) => { const v = e.target.value; setTex(v); clearTimeout(timer.current); timer.current = setTimeout(() => compile(v), 1000) }} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => compile(tex)}>Compile now</Button>
                  <Button variant="outline" disabled={!errors.length} onClick={fixWithAi}>Fix with AI</Button>
                  <Button variant="outline" onClick={async () => { await api("/cv/save", { kind: slot, tex }); say("Draft saved", "ok"); await loadSlots() }}>Save draft</Button>
                  <Button disabled={!tex.trim()} onClick={publish}>Publish as {slotLabel}</Button>
                </div>
              </CardContent>
            </Card>
            <Card aria-label="Preview" id="preview">
              <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {errors.length > 0 && <ul className="errors space-y-1">{errors.map((e, n) => <li key={n}><button className="text-left text-sm text-destructive underline-offset-2 hover:underline" onClick={() => jumpTo(e.line)}>{e.line ? `Line ${e.line}: ${e.msg}` : e.msg}</button></li>)}</ul>}
                {pages.length ? <Pages list={pages} label="Compiled CV" /> : <Note>The compiled CV appears here.</Note>}
              </CardContent>
            </Card>
          </div>
        </>}

        {view === "import" && <>
          <Card>
            <CardHeader><CardTitle>Turn a PDF into tex for the {slotLabel}</CardTitle>
              <CardDescription>The local model reads the text of your PDF, a template writes the tex, tectonic compiles it, and the model fixes compile errors. Nothing replaces your CV until you publish from the editor.</CardDescription></CardHeader>
            <CardContent>
              <label>
                <input type="file" accept="application/pdf" className="sr-only" aria-label="Choose a CV PDF" onChange={(e) => runImport(e.target.files?.[0])} />
                <Button asChild disabled={!!imp?.busy}><span>{imp?.busy ? "Working" : "Choose a PDF"}</span></Button>
              </label>
            </CardContent>
          </Card>
          {imp?.error && <Alert variant="destructive"><AlertDescription>{imp.error}</AlertDescription></Alert>}
          {imp?.tex && <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card><CardHeader><CardTitle>Your original</CardTitle></CardHeader><CardContent><Pages list={imp.original_pages} label="Original CV" /></CardContent></Card>
              <Card><CardHeader><CardTitle>Compiled from the tex</CardTitle></CardHeader><CardContent><Pages list={imp.pages} label="Imported CV" /></CardContent></Card>
            </div>
            <Card>
              <CardHeader><CardTitle>{imp.unverified.length ? `${imp.unverified.length} piece${imp.unverified.length === 1 ? "" : "s"} of text not found in your PDF` : "Every piece of text was found in your PDF"}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {imp.unverified.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-warning">{imp.unverified.map((u: string, n: number) => <li key={n}>{u}</li>)}</ul>}
                {!imp.compile.ok && <Note warn>It still does not compile: {imp.compile.errors.map((e: any) => e.msg).join("; ")}</Note>}
                {imp.fix_rounds ? <Note>The model fixed compile errors in {imp.fix_rounds} round{imp.fix_rounds === 1 ? "" : "s"}.</Note> : null}
                <Button onClick={async () => { await loadTex(slot); setView("edit") }}>Open in the editor</Button>
              </CardContent>
            </Card>
          </>}
        </>}

        {view === "tailor" && <>
          <Card>
            <CardHeader><CardTitle>Tailor the {slotLabel} to a job</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label htmlFor="co">Company</Label><Input id="co" className="field-input" value={jd.company} onChange={(e) => setJd({ ...jd, company: e.target.value })} /></div>
                <div className="space-y-1.5"><Label htmlFor="ro">Role</Label><Input id="ro" className="field-input" value={jd.title} onChange={(e) => setJd({ ...jd, title: e.target.value })} /></div>
              </div>
              <div className="space-y-1.5"><Label htmlFor="jd">Job description</Label>
                <Textarea id="jd" className="jd h-56" aria-label="Job description" value={jd.text} onChange={(e) => setJd({ ...jd, text: e.target.value })} /></div>
              <Note>Only the summary and skills are rewritten, and only with words your CV already supports. Anything else is refused and listed.</Note>
              <div className="flex items-center gap-3">
                <Button disabled={!!tailor?.busy || jd.text.trim().length < 200} onClick={runTailor}>{tailor?.busy ? "Working" : "Tailor my CV"}</Button>
                {jd.text.trim().length < 200 && <Note>Paste at least a few sentences of the job description.</Note>}
              </div>
            </CardContent>
          </Card>
          {tailor?.error && <Alert variant="destructive"><AlertDescription>{tailor.error}</AlertDescription></Alert>}
          {tailor?.tex_after && <TailorResult t={tailor} slot={slot} say={say} saveTailored={saveTailored} edit={() => { setTex(tailor.tex_after); setMeta({}); setErrors([]); setPages(tailor.pages); setView("edit"); compile(tailor.tex_after) }} />}
        </>}
      </main>
    </div>
  )
}

function TailorResult({ t, say, saveTailored, edit }: { t: any; slot: string; say: (t: string, tone?: string) => void; saveTailored: () => Promise<any>; edit: () => void }) {
  const body = t.diff.filter((l: string) => !l.startsWith("---") && !l.startsWith("+++"))
  return (
    <div className="space-y-4">
      {t.similar && (
        <Card>
          <CardHeader><CardTitle>Very close to the CV you made for {t.similar.company || "an earlier job"}</CardTitle>
            <CardDescription>career-ops rates the two job descriptions as {Math.round(t.similar.score * 100)}% alike, so that CV can be reused instead.</CardDescription></CardHeader>
          <CardContent><Button variant="outline" onClick={async () => { const r = await api("/cv/tailored/get", { folder: t.similar.folder }); if (r.error) say(r.error, "warn"); else download(r.name, r.base64) }}>Download that CV</Button></CardContent>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>What changed</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {t.matched.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Job keywords your CV already covers">{t.matched.map((k: string) => <li key={k}><Badge variant="secondary">{k}</Badge></li>)}</ul>}
            {Object.entries(t.regions).map(([name, r]: [string, any]) => (
              <Note key={name} warn={r.skipped}>{r.skipped ? `The ${name} was kept as it was. The rewrite used words your CV does not support: ${r.flagged.join(", ") || "none named"}.` : r.changed ? `The ${name} was reworded for this job.` : `The ${name} already fits.`}</Note>
            ))}
            {body.length ? (
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                {body.map((l: string, n: number) => <span key={n} className={`block ${l.startsWith("+") ? "text-success" : l.startsWith("-") ? "text-destructive" : "text-muted-foreground"}`}>{l || " "}</span>)}
              </pre>
            ) : <Note>No changes: the CV already matches this job as far as the rules allow.</Note>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
          <CardContent>{t.ok ? <Pages list={t.pages} label="Tailored CV" /> : <Note warn>It does not compile: {t.errors.map((e: any) => e.msg).join("; ")}</Note>}</CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="flex flex-wrap gap-2">
          <Button disabled={!t.ok} onClick={async () => { const r = await saveTailored(); if (r) { download(r.name, r.base64); say(`Saved ${r.name}`, "ok") } }}>Download PDF</Button>
          <Button variant="outline" disabled={!t.ok || !tabId} onClick={async () => {
            const r = await saveTailored(); if (!r) return
            const out = await send("attach-file", { kind: "resume", name: r.name, base64: r.base64 })
            say(out?.error ? out.error : `Attached ${r.name} to the form.`, out?.error ? "warn" : "ok")
          }}>Attach to the open form</Button>
          <Button variant="outline" onClick={edit}>Edit this tex</Button>
        </CardContent>
      </Card>
    </div>
  )
}

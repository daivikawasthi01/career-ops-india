import { useEffect, useRef, useState } from "react"
import { ExternalLink, FileText, Loader2, Mail, Paperclip, PenLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, pollJob } from "@/lib/chrome"

export type Person = { name: string; title: string; kind: string; source: string; linkedin: string | null }
type Draft = { subject: string; body: string }
type Made = { url: string; files: string[]; attached: string[]; note: string }

// A cold email to one person: written from your CV and the job, edited by you, and left as a Gmail draft with the CV and a cover letter
// attached. Nothing is ever sent from here; you open the draft in Gmail and press Send.
export function OutreachPanel({ person, company, title, jdText, jobUrl, options }: { person: Person; company: string; title: string; jdText: string; jobUrl: string; options: string[] }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [to, setTo] = useState(options[0] || "")
  const [cv, setCv] = useState(true)
  const [cover, setCover] = useState(true)
  const [busy, setBusy] = useState<"" | "writing" | "creating" | "connecting">("")
  const [error, setError] = useState("")
  const [made, setMade] = useState<Made | null>(null)
  const [gmail, setGmail] = useState<{ configured: boolean; connected: boolean } | null>(null)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; api("/gmail/status").then((g) => alive.current && !g.error && setGmail(g)); return () => { alive.current = false } }, [])
  useEffect(() => { if (!to && options[0]) setTo(options[0]) }, [options]) // eslint-disable-line react-hooks/exhaustive-deps

  const body = { person, company, title, jd_text: jdText, url: jobUrl }
  const write = async () => {
    setBusy("writing"); setError(""); setMade(null)
    const r = await api("/outreach/draft", body)
    setBusy("")
    if (r.error) setError(r.detail ? `${r.error}: ${r.detail}` : String(r.error))
    else setDraft({ subject: r.subject, body: r.body })
  }
  const connect = async () => {
    setError("")
    const r = await api("/gmail/connect")
    if (r.error) { setError(String(r.error)); return }
    chrome.tabs.create({ url: r.url, active: true })
    setBusy("connecting")
    for (let i = 0; i < 60 && alive.current; i++) { // the sign-in finishes in the other tab
      await new Promise((res) => setTimeout(res, 2000))
      const g = await api("/gmail/status")
      if (g.connected) { setGmail(g); break }
    }
    setBusy("")
  }
  const create = async () => {
    if (!draft) return
    setBusy("creating"); setError("")
    const first = await api("/outreach/gmail", { ...body, to, subject: draft.subject, body: draft.body, attach_cv: cv, attach_cover: cover })
    if (first.error) { setBusy(""); setError(String(first.error)); return }
    const done = await pollJob(first.job)
    setBusy("")
    if (done.status === "done") setMade(done.result)
    else { setError(done.error || "Could not create the draft."); api("/gmail/status").then((g) => !g.error && setGmail(g)) }
  }
  const compose = async () => {
    if (!draft) return
    const r = await api("/outreach/compose", { to, subject: draft.subject, body: draft.body, person, company })
    if (r.error) setError(String(r.error)); else chrome.tabs.create({ url: r.url, active: true })
  }

  const words = draft ? draft.body.split(/\s+/).filter(Boolean).length : 0
  return (
    <div className="mt-2 space-y-2 rounded-lg border bg-muted/30 p-2.5" data-outreach={person.name}>
      {!draft && (
        <Button size="xs" onClick={write} disabled={busy === "writing"}>{busy === "writing" ? <Loader2 className="animate-spin" /> : <PenLine />}Write the email</Button>
      )}
      {error && <p className="text-xs text-warning">{error}</p>}
      {draft && !made && (
        <>
          <Input list={`to-${person.name}`} placeholder="To: pick a checked address or type one" aria-label="To" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          <datalist id={`to-${person.name}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
          <Input aria-label="Subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <Textarea aria-label="Email body" rows={9} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <p className={`text-xs ${words > 120 ? "text-warning" : "text-muted-foreground"}`}>{words} words. Cold emails work best short. Read it before you send.</p>
          <div className="space-y-1.5">
            <label className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-1.5"><Paperclip className="size-3.5" />Attach my CV (chosen for the role)</span><Switch checked={cv} onCheckedChange={setCv} /></label>
            <label className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-1.5"><FileText className="size-3.5" />Attach a cover letter for this job</span><Switch checked={cover} onCheckedChange={setCover} /></label>
          </div>
          <div className="flex flex-wrap gap-2">
            {gmail?.connected && <Button size="xs" onClick={create} disabled={!to || busy === "creating"}>{busy === "creating" ? <Loader2 className="animate-spin" /> : <Mail />}{busy === "creating" ? "Making the draft" : "Create Gmail draft"}</Button>}
            {gmail?.configured && !gmail.connected && <Button size="xs" onClick={connect} disabled={busy === "connecting"}>{busy === "connecting" ? <Loader2 className="animate-spin" /> : <Mail />}{busy === "connecting" ? "Finish signing in, in the other tab" : "Connect Gmail"}</Button>}
            <Button size="xs" variant="outline" onClick={compose} disabled={!to}><ExternalLink />Open in Gmail (no attachments)</Button>
            <Button size="xs" variant="ghost" onClick={write} disabled={busy === "writing"}>{busy === "writing" ? <Loader2 className="animate-spin" /> : null}Write again</Button>
          </div>
          {gmail && !gmail.configured && <p className="text-xs text-muted-foreground">To attach files, save your Google OAuth client as data/gmail-credentials.json. Until then "Open in Gmail" works without attachments.</p>}
          <p className="text-xs text-muted-foreground">Nothing is sent. A draft waits in Gmail until you press Send.</p>
        </>
      )}
      {made && (
        <div className="space-y-1.5 text-xs" data-made>
          <p className="font-medium text-success">Draft created in Gmail. Nothing was sent.</p>
          {made.attached.map((n) => <p key={n} className={n.includes("NOT") ? "text-warning" : "text-muted-foreground"}>{n}</p>)}
          {made.note && <p className="text-muted-foreground">Noted in your contacts: {made.note}.</p>}
          <Button size="xs" onClick={() => chrome.tabs.create({ url: made.url, active: true })}><ExternalLink />Open the draft in Gmail</Button>
        </div>
      )}
    </div>
  )
}

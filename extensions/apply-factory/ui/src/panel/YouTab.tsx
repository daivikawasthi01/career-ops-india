import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/chrome"
import { CvCard, Setting } from "./cards"
import { Hint } from "./forms"
import { SetupWizard } from "./Wizard"
import type { Panel } from "./usePanel"

type Answer = { intent_key: string; answer: string; questions: string[]; seen_count: number }

function AnswerRow({ a, onChanged }: { a: Answer; onChanged: () => void }) {
  const [armed, setArmed] = useState(false)
  const [note, setNote] = useState("")
  const label = a.questions[0] || a.intent_key.replace(/_/g, " ")
  return (
    <div className="space-y-1.5 border-t py-2.5 first:border-t-0 first:pt-0">
      <p className="text-sm font-medium leading-snug">{label}</p>
      <Input defaultValue={a.answer} aria-label={`Saved answer for ${label}`}
        onBlur={async (e) => { const v = e.target.value.trim(); if (v === a.answer) return; const r = await api("/answers/update", { intent_key: a.intent_key, answer: v }); setNote(r.error ? r.error : "Saved."); if (!r.error) onChanged() }} />
      <div className="flex items-center gap-3">
        <Hint>Used on {a.seen_count} form{a.seen_count === 1 ? "" : "s"}.</Hint>
        <button className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive"
          onClick={async () => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3000); return } await api("/answers/delete", { intent_key: a.intent_key }); onChanged() }}>
          {armed ? "Press again to forget it" : "Forget"}
        </button>
      </div>
      {note && <Hint warn={note !== "Saved."}>{note}</Hint>}
    </div>
  )
}

function Answers() {
  const [q, setQ] = useState("")
  const [data, setData] = useState<{ total: number; rows: Answer[] } | null>(null)
  const [err, setErr] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const load = useCallback(async (query: string) => {
    const res = await api("/answers/list", { q: query, limit: 40 })
    if (res.error) setErr(res.error); else { setErr(""); setData(res) }
  }, [])
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(() => load(q), 250); return () => clearTimeout(timer.current) }, [q, load])
  return (
    <Card size="sm">
      <CardHeader><CardTitle>Saved answers</CardTitle>
        <CardDescription>What Apply learned from the forms you filled. Fix one here if it is wrong, and it is used from the next form on.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <Input placeholder="Search your answers" aria-label="Search your saved answers" value={q} onChange={(e) => setQ(e.target.value)} />
        {err && <Hint warn>{err}</Hint>}
        {data && !data.rows.length && <Hint>{q ? "No saved answer matches." : "Nothing saved yet. Fill in a form by hand and Apply learns it."}</Hint>}
        {data?.rows.map((a) => <AnswerRow key={a.intent_key + a.answer} a={a} onChanged={() => load(q)} />)}
        {data && data.total > data.rows.length && <Hint>Showing {data.rows.length} of {data.total}. Search to narrow it down.</Hint>}
      </CardContent>
    </Card>
  )
}

// The person's own samples: how they write to a recruiter and how their cover letter is laid out. Kept on this Mac and used to steer the drafts.
function StyleCard() {
  const [v, setV] = useState<{ emails: string; cover_tex: string } | null>(null)
  const [orig, setOrig] = useState<{ emails: string; cover_tex: string } | null>(null)
  const [note, setNote] = useState("")
  useEffect(() => { api("/style", {}).then((r) => { if (!r.error) { setV(r); setOrig(r) } }) }, [])
  if (!v || !orig) return null
  const dirty = v.emails !== orig.emails || v.cover_tex !== orig.cover_tex
  const save = async () => {
    setNote("")
    const r = await api("/style", { emails: v.emails, cover_tex: v.cover_tex })
    if (r.error) { setNote(r.error); return }
    setV(r); setOrig(r); setNote("Saved.")
  }
  return (
    <Card size="sm">
      <CardHeader><CardTitle>Your writing samples</CardTitle>
        <CardDescription>Paste an email and a cover letter you wrote and liked. Drafts copy their voice, structure and layout, and use only facts from your CV. Optional, and kept on this Mac.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <label className="block space-y-1"><span className="text-xs text-muted-foreground">Cold emails you wrote. Separate two or three with a line of ---</span>
          <Textarea rows={8} value={v.emails} onChange={(e) => { setNote(""); setV({ ...v, emails: e.target.value }) }} placeholder="Respected Ma'am, ..." /></label>
        <label className="block space-y-1"><span className="text-xs text-muted-foreground">Your cover letter as LaTeX. Your layout is kept exactly; the body, recipient, date and subject are replaced for each job.</span>
          <Textarea rows={8} className="font-mono text-xs" spellCheck={false} value={v.cover_tex} onChange={(e) => { setNote(""); setV({ ...v, cover_tex: e.target.value }) }} placeholder="\documentclass{...}" /></label>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!dirty} onClick={save}>Save samples</Button>
          {note && <Hint warn={note !== "Saved."}>{note}</Hint>}
        </div>
      </CardContent>
    </Card>
  )
}

// Gmail drafts: sign in once with Google. Apply can only create drafts (never send or read mail). Needs the Google OAuth file, which is the one
// setup step that cannot be done from the panel, so the card says exactly what to do.
function GmailCard() {
  const [g, setG] = useState<{ configured: boolean; connected: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const alive = useRef(true)
  useEffect(() => { alive.current = true; api("/gmail/status", {}).then((r) => alive.current && !r.error && setG(r)); return () => { alive.current = false } }, [])
  if (!g) return null
  const connect = async () => {
    setNote("")
    const r = await api("/gmail/connect", {})
    if (r.error) { setNote(String(r.error)); return }
    chrome.tabs.create({ url: r.url, active: true })
    setBusy(true)
    for (let i = 0; i < 60 && alive.current; i++) {   // the sign-in finishes in the other tab
      await new Promise((res) => setTimeout(res, 2000))
      const s = await api("/gmail/status", {})
      if (s.connected) { setG(s); break }
    }
    setBusy(false)
  }
  return (
    <Card size="sm">
      <CardHeader><CardTitle>Email drafts (optional)</CardTitle>
        <CardDescription>Apply can put a cold email, with your CV and a cover letter attached, into your Gmail drafts. It never sends and never reads your mail.</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        {g.connected && <>
          <Hint>Gmail is connected. Open the Company tab, find a person and press Draft email.</Hint>
          <Button size="xs" variant="outline" onClick={async () => { await api("/gmail/disconnect", {}); setG({ ...g, connected: false }) }}>Disconnect</Button>
        </>}
        {!g.connected && g.configured && <>
          <Hint>One sign-in with Google, in a new tab. Google may warn that the app is not verified: choose Advanced, then continue.</Hint>
          <Button size="sm" disabled={busy} onClick={connect}>{busy ? "Finish signing in, in the other tab" : "Connect Gmail"}</Button>
        </>}
        {!g.configured && <>
          <Hint>This needs a one-time Google setup, because Google requires every app to have its own key. Without it, "Open in Gmail" still opens a ready message, just without attachments.</Hint>
          <Hint>In Google Cloud (console.cloud.google.com): create a project, enable the Gmail API, then Credentials, Create credentials, OAuth client ID, type Desktop app, add yourself as a test user, download the JSON and save it as extensions/apply-factory/data/gmail-credentials.json. Then reopen this tab.</Hint>
        </>}
        {note && <Hint warn>{note}</Hint>}
      </CardContent>
    </Card>
  )
}

function Stats() {
  const [s, setS] = useState<any>(null)
  useEffect(() => { api("/stats", {}).then((r) => { if (!r.error) setS(r) }) }, [])
  if (!s) return null
  const w = s.week
  return (
    <Card size="sm">
      <CardHeader><CardTitle>This week</CardTitle></CardHeader>
      <CardContent className="space-y-1">
        <p className="text-sm">{w.fills} answers filled on {w.forms} form{w.forms === 1 ? "" : "s"}, {w.drafts} drafts inserted.</p>
        <p className="text-sm text-muted-foreground">About {w.minutes_saved} minutes saved. {s.note}</p>
      </CardContent>
    </Card>
  )
}

export function YouTab({ p }: { p: Panel }) {
  const { st, send } = p
  if (!st || st.error) return <Hint>Start the local helper first. The Page tab shows how.</Hint>
  return (
    <div className="space-y-3">
      <SetupWizard p={p} />
      <Answers />
      <CvCard p={p} />
      <Card size="sm">
        <CardHeader><CardTitle>Behaviour</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Setting label="Fill saved answers when a form opens" value={!!st.auto} onChange={(v) => send("set-auto", { auto: v })} />
          <Setting label="Open Apply on the page when a form is found" value={st.autoOpen === true} onChange={(v) => send("set-auto", { autoOpen: v })} />
        </CardContent>
      </Card>
      <StyleCard />
      <GmailCard />
      <Stats />
      <Card size="sm">
        <CardHeader><CardTitle>What leaves this Mac</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Hint>Your answers, details and CV files stay on this Mac. When you draft an answer or a job is scored, the question, the job text and the relevant parts of your CV are sent to the model service named at the top (Groq or Gemini, then Claude if both are unavailable).</Hint>
          <Hint>Email checks in the Company tab contact the company's mail server directly. Passwords, card numbers and ID numbers are never read.</Hint>
        </CardContent>
      </Card>
    </div>
  )
}

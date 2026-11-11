import { useEffect, useRef, useState } from "react"
import { Building2, Check, Copy, ExternalLink, Link2, Loader2, Mail, PenLine, Phone, RefreshCw, Search, UserRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, pollJob, send } from "@/lib/chrome"
import { OutreachPanel } from "./OutreachPanel"

type Person = { name: string; title: string; location?: string | null; kind: string; source: string; linkedin: string | null; partial?: boolean }
type Result = {
  company: string; domain: string; domain_from: string; location?: string; hq?: string; summary?: string; generated_at?: string; cached_at?: string
  size: { employees: number | null; note: string | null; band: string; source: string | null }
  people: Person[]; roles_wanted: string[]; warnings: string[]; sources: { title: string; uri: string }[]
  contacts: { emails: { address: string; source: string }[]; phones: { number: string; source: string }[]; pages: string[] }
  network: { name: string; title: string; url: string }[]
  email_domains: { domain: string; from: string; provider: string }[]; email_shapes: string[]; email_examples: { name: string; address: string; source: string }[]
}
type Row = { address: string; shape: string; verdict: string; risk: { bounce: { band: string; why: string }; spam: { band: string; why: string[] }; note: string } }
type Mail = { rows: Row[]; provider: string; catch_all: boolean | null; policy: { spf: boolean; dmarc: string } }

const BAND_LABEL: Record<string, string> = { startup: "Startup", small: "Small company", mid: "Mid-size", large: "Large company", unknown: "Size unknown" }
const VERDICT: Record<string, [string, string]> = {
  accepted: ["Mailbox exists", "text-success border-success/40"],
  "accepted-unconfirmed": ["Probably exists", "text-success border-success/40"],
  "catch-all": ["Server accepts anything", "text-warning border-warning/50"],
  temporary: ["Not confirmed, try later", "text-warning border-warning/50"],
  blocked: ["Check was refused", "text-warning border-warning/50"],
  unreachable: ["Could not reach the server", "text-muted-foreground"],
  skipped: ["Not checked", "text-muted-foreground"],
  rejected: ["Does not exist", "text-destructive border-destructive/40"],
  "no-mail-server": ["Domain takes no mail", "text-destructive border-destructive/40"],
}
const BAND_TONE: Record<string, string> = { low: "text-success", medium: "text-warning", high: "text-destructive" }
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "") } catch { return u } }
const ago = (iso?: string) => {
  if (!iso) return ""
  const n = Math.floor((Date.now() - new Date(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z")).getTime()) / 86400000)
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button size="icon-xs" variant="ghost" aria-label={label} onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200) }}>
      {done ? <Check /> : <Copy />}
    </Button>
  )
}

function SourceLink({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline">{host(url)}<ExternalLink className="size-3" /></a>
}

const RULED_OUT = new Set(["rejected", "skipped", "no-mail-server"])
// Addresses worth offering as the recipient: the ones the check did not rule out, best first.
const addressOptions = (m: Mail | "busy" | string | undefined): string[] => (m && typeof m === "object" ? m.rows.filter((r) => !RULED_OUT.has(r.verdict)).map((r) => r.address) : [])

function MailRow({ r }: { r: Row }) {
  const [label, tone] = VERDICT[r.verdict] || [r.verdict, ""]
  return (
    <Collapsible className="rounded-lg border px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.address}>{r.address}</span>
        <Badge variant="outline" className={`shrink-0 font-normal ${tone}`}>{label}</Badge>
        <CopyButton text={r.address} label={`Copy ${r.address}`} />
      </div>
      <CollapsibleTrigger asChild><button className="pt-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
        Bounce risk <span className={BAND_TONE[r.risk.bounce.band]}>{r.risk.bounce.band}</span>, spam risk <span className={BAND_TONE[r.risk.spam.band]}>{r.risk.spam.band}</span>
      </button></CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 pt-1.5 text-xs text-muted-foreground">
        <p>Bounce: {r.risk.bounce.why}.</p>
        <p>Spam: {r.risk.spam.why.join("; ")}.</p>
        <p className="italic">{r.risk.note}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Every pattern is tried; the ones that could be real come first and the ruled-out guesses fold away.
function MailRows({ mail }: { mail: Mail }) {
  const live = mail.rows.filter((r) => !RULED_OUT.has(r.verdict))
  const out = mail.rows.filter((r) => RULED_OUT.has(r.verdict))
  return (
    <div className="space-y-1.5 pt-2" data-mail>
      {live.map((r) => <MailRow key={r.address} r={r} />)}
      {!live.length && <p className="text-xs text-muted-foreground">None of the {mail.rows.length} patterns tried matched a mailbox.</p>}
      {out.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild><button className="text-xs text-muted-foreground underline-offset-2 hover:underline">{out.length} other pattern{out.length > 1 ? "s" : ""} ruled out</button></CollapsibleTrigger>
          <CollapsibleContent className="space-y-1.5 pt-1.5">{out.map((r) => <MailRow key={r.address} r={r} />)}</CollapsibleContent>
        </Collapsible>
      )}
      <p className="text-xs text-muted-foreground">
        Mail runs on {mail.provider}; SPF {mail.policy.spf ? "set" : "missing"}, DMARC {mail.policy.dmarc}.
        {mail.catch_all ? " This server accepts every address, so a yes here proves nothing." : ""}
      </p>
    </div>
  )
}

// The company on the open page: size, the people worth writing to, public contact details, and a no-send check of guessed addresses.
export function CompanyTab({ seed }: { seed: { company: string; location: string } }) {
  const [name, setName] = useState(seed.company)
  const [location, setLocation] = useState(seed.location)
  const [title, setTitle] = useState("")
  const [website, setWebsite] = useState("")   // when the name is shared by several companies, the site says which one
  const [jobUrl, setJobUrl] = useState("")
  const [jdText, setJdText] = useState("")
  const [writing, setWriting] = useState<Record<string, boolean>>({}) // people whose email panel is open
  const [domain, setDomain] = useState("")
  const [picked, setPicked] = useState<string[]>([])   // work-email domains to try, in order
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [mail, setMail] = useState<Record<string, Mail | "busy" | string>>({})
  const seq = useRef(0)

  // Pick up the company and job from the page that is open, unless the user already typed one.
  useEffect(() => {
    send("job-context").then((c: any) => {
      if (!c) return
      setJobUrl(c.url || ""); setTitle(c.title || ""); setJdText(String(c.jd_text || "").slice(0, 4000))
      if (!seed.company && c.company) setName((n) => n || c.company)
    }).catch(() => {})
  }, [seed.company])

  const start = async (refresh: boolean, cacheOnly = false) => {
    const company = name.trim()
    if (!company) return
    const mine = ++seq.current
    setBusy(!cacheOnly); setError(""); if (!cacheOnly) setMail({})
    const first = await api("/company/start", { company, url: jobUrl, title, location: location.trim(), website: website.trim(), refresh, cache_only: cacheOnly })
    if (mine !== seq.current) return
    if (first.error) { setBusy(false); setError(first.error === "server offline" ? "The local server is not running." : String(first.error)); return }
    const take = (r: Result) => { setRes(r); setDomain(r.domain || ""); setPicked((r.email_domains || []).map((d) => d.domain)) }
    if (first.cached) { take(first.result); setBusy(false); return }
    if (cacheOnly) { setBusy(false); return }
    const done = await pollJob(first.job)
    if (mine !== seq.current) return
    setBusy(false)
    if (done.status === "done") take(done.result)
    else setError(done.error || "Research failed.")
  }

  // Opening the tab on a company shows the saved answer straight away; it only searches when asked.
  useEffect(() => { if (name.trim()) { const t = setTimeout(() => start(false, true), 300); return () => clearTimeout(t) } }, [name, location]) // eslint-disable-line react-hooks/exhaustive-deps

  const checkMail = async (key: string, path: string, body: Record<string, unknown>) => {
    setMail((m) => ({ ...m, [key]: "busy" }))
    const first = await api(path, body)
    if (first.error) { setMail((m) => ({ ...m, [key]: String(first.error) })); return }
    const done = await pollJob(first.job)
    setMail((m) => ({ ...m, [key]: done.status === "done" ? done.result : done.error || "Check failed." }))
  }
  const known = (res?.contacts.emails || []).map((e) => e.address)
  const tryDomains = picked.length ? picked : domain ? [domain] : []
  const slot = (key: string) => {
    const v = mail[key]
    if (v === "busy") return <p className="flex items-center gap-1.5 pt-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Checking with the mail server, this takes up to a minute.</p>
    if (typeof v === "string") return <p className="pt-2 text-xs text-warning">{v}</p>
    return v ? <MailRows mail={v} /> : null
  }

  return (
    <div className="space-y-3" data-tab="company">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); start(false) }}>
        <div className="relative flex-1">
          <Building2 className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Company name" aria-label="Company" value={name} onChange={(e) => { setName(e.target.value); setRes(null) }} />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Search />}Research</Button>
      </form>
      <Input placeholder="Company website (optional, if the name is shared)" title="Several companies can share a name. Paste the right company's website and it is used instead of a guess" aria-label="Company website" value={website} onChange={(e) => { setWebsite(e.target.value); setRes(null) }} />
      <Input placeholder="Job city (optional)" title="Left empty, HR is searched in India: Bangalore, Hyderabad and Gurugram" aria-label="Job city" value={location} onChange={(e) => { setLocation(e.target.value); setRes(null) }} />

      {busy && (
        <div className="space-y-2 rounded-xl border p-3" aria-busy="true">
          <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Looking up {name.trim()}. This takes about a minute.</p>
          <Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-16" />
        </div>
      )}
      {error && <p className="rounded-lg border border-warning/50 p-3 text-sm text-warning">{error}</p>}
      {!res && !busy && !error && <p className="px-1 py-6 text-center text-sm text-muted-foreground">Press Research for company size, the people to write to, and their public contact details. Only public pages are used and nothing is sent to anyone.</p>}

      {res && !busy && (
        <>
          <section className="space-y-2 rounded-xl border p-3" aria-label="Overview">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{res.company}</h2>
                <p className="text-xs text-muted-foreground">{[res.hq, res.domain].filter(Boolean).join(" · ")}</p>
              </div>
              <Button size="xs" variant="ghost" onClick={() => start(true)}><RefreshCw />Refresh</Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={res.size.band === "unknown" ? "outline" : "secondary"}>{BAND_LABEL[res.size.band]}</Badge>
              {res.size.employees && <span className="text-xs text-muted-foreground">{res.size.note || `about ${res.size.employees.toLocaleString()} people`}</span>}
              {res.size.source && <SourceLink url={res.size.source} />}
            </div>
            {res.summary && <p className="text-sm">{res.summary}</p>}
            <p className="text-xs text-muted-foreground">Researched {ago(res.cached_at || res.generated_at) || "just now"}.</p>
            {res.warnings.map((w) => <p key={w} className="text-xs text-warning">{w}</p>)}
          </section>

          <section className="space-y-2" aria-label="People">
            <h3 className="px-0.5 text-sm font-medium">People to write to</h3>
            {res.roles_wanted.length > 0 && <p className="px-0.5 text-xs text-muted-foreground">For a {BAND_LABEL[res.size.band].toLowerCase()}: {res.roles_wanted.join(", ")}.</p>}
            {(res.email_domains || []).length > 0 && (
              <div className="space-y-1.5 rounded-xl border p-3" data-domains>
                <p className="text-xs font-medium text-muted-foreground">Work email domain (the first that answers wins)</p>
                <ToggleGroup type="multiple" variant="outline" size="sm" className="flex flex-wrap justify-start gap-1.5" value={picked} onValueChange={setPicked}>
                  {res.email_domains.map((d) => <ToggleGroupItem key={d.domain} value={d.domain} className="h-7 rounded-full px-2.5 text-xs">{d.domain} <span className="ml-1 text-muted-foreground">{d.from}</span></ToggleGroupItem>)}
                </ToggleGroup>
                {res.email_examples.length > 0 && <p className="text-xs text-muted-foreground">Seen on public pages: {res.email_examples.slice(0, 3).map((e) => e.address).join(", ")}{res.email_shapes.length ? `. Pattern: ${res.email_shapes[0]}.` : "."}</p>}
              </div>
            )}
            {!(res.email_domains || []).length && <Input placeholder="Email domain, for example acme.com" aria-label="Company domain" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} />}
            <ul className="space-y-2">
              {res.people.map((p) => (
                <li key={p.name} className="rounded-xl border p-3" data-person={p.name}>
                  <div className="flex items-start gap-2">
                    <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground" title={p.title}>{p.title}{p.location ? ` (${p.location})` : ""}</p>
                      {p.partial && <p className="text-xs text-warning">Only an initial for the last name, so only first-name guesses are possible.</p>}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Badge variant="secondary" className="font-normal">{p.kind}</Badge>
                        <SourceLink url={p.source} />
                        {p.linkedin && <a href={p.linkedin} target="_blank" rel="noreferrer" aria-label={`${p.name} on LinkedIn`} className="text-muted-foreground hover:text-foreground"><Link2 className="size-3.5" /></a>}
                      </div>
                    </div>
                    <Button size="xs" variant="outline" onClick={() => setWriting((w) => ({ ...w, [p.name]: !w[p.name] }))}><PenLine />Draft email</Button>
                    <Button size="xs" variant="outline" disabled={!tryDomains.length || mail[p.name] === "busy"} onClick={() => checkMail(p.name, "/mail/find", { name: p.name, domains: tryDomains, known, prefer: res?.email_shapes || [] })}><Mail />Find email</Button>
                  </div>
                  {slot(p.name)}
                  {writing[p.name] && <OutreachPanel person={p} company={res.company} title={title} jdText={jdText} jobUrl={jobUrl} options={addressOptions(mail[p.name])} />}
                </li>
              ))}
              {!res.people.length && <li className="rounded-xl border p-4 text-center text-sm text-muted-foreground">No named people with a source page were found.</li>}
            </ul>
          </section>

          <section className="space-y-2 rounded-xl border p-3" aria-label="Public contacts">
            <h3 className="text-sm font-medium">Public contacts</h3>
            {res.contacts.emails.length === 0 && res.contacts.phones.length === 0 && <p className="text-xs text-muted-foreground">No email or phone was published on {res.contacts.pages.length ? "the pages checked" : "the company site (it could not be read)"}.</p>}
            <ul className="space-y-1">
              {res.contacts.emails.map((e) => (
                <li key={e.address} className="flex items-center gap-2"><Mail className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{e.address}</span><SourceLink url={e.source} /><CopyButton text={e.address} label={`Copy ${e.address}`} /></li>
              ))}
              {res.contacts.phones.map((p) => (
                <li key={p.number} className="flex items-center gap-2"><Phone className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs">{p.number}</span><SourceLink url={p.source} /><CopyButton text={p.number} label={`Copy ${p.number}`} /></li>
              ))}
            </ul>
            {tryDomains.length > 0 && (
              <div>
                <Button size="xs" variant="outline" disabled={mail.generic === "busy"} onClick={() => checkMail("generic", "/mail/generic", { domains: [tryDomains[0]] })}><Mail />Check careers@, jobs@, hr@ and similar</Button>
                {slot("generic")}
              </div>
            )}
          </section>

          {res.network.length > 0 && (
            <section className="space-y-1 rounded-xl border p-3" aria-label="People you know">
              <h3 className="text-sm font-medium">People you already know here</h3>
              {res.network.map((n) => <p key={n.name} className="text-xs"><a href={n.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{n.name}</a><span className="text-muted-foreground">{n.title ? `, ${n.title}` : ""}</span></p>)}
            </section>
          )}

          <p className="px-1 pb-2 text-xs text-muted-foreground">
            Names come from web pages that are linked above; check them before writing. Mail checks ask the company's mail server whether an address exists and never send a message.
            Some servers accept everything or refuse the check, and the risk bands are estimates.
          </p>
        </>
      )}
    </div>
  )
}

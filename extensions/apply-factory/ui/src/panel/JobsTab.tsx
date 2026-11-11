import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, Check, ChevronDown, Filter, Loader2, MoreHorizontal, Search, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api } from "@/lib/chrome"
import { BlacklistPanel } from "./BlacklistPanel"

type Job = { years: string; entry: boolean; id: string; url: string; company: string; title: string; location: string; first_seen: string; sources: string[]; confirmed: boolean; flags: string[]; mark: string; stipend: string }
type Check = { running: boolean; done: number; total: number; error: string; removed?: number }
type Fit = { on: boolean; limit: number; hidden: { senior: number; years: number; location: number; blacklist?: number; experience?: number }; unchecked: number; check: Check }
type Page = { fit: Fit; total: number; all: number; latest: string; rows: Job[]; facets: { sources: [string, number][]; marked: number } }
const PAGE = 40
const EXPERIENCE: [string, string][] = [["any", "Any"], ["0", "None needed"], ["1", "Up to 1"], ["2", "Up to 2"], ["3", "Up to 3"], ["5", "Up to 5"]]
const DAYS: [string, string][] = [["0", "Any time"], ["1", "Today"], ["3", "3 days"], ["7", "7 days"]]

const age = (d: string) => {
  // first_seen is a date, but tolerate a timestamp too: "2026-11-10 09:30" used to become "NaN days ago".
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d + "T00:00:00" : String(d || "").replace(" ", "T")).getTime()
  if (!Number.isFinite(t)) return ""
  const n = Math.floor((Date.now() - t) / 86400000)
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`
}

// The scanner's jobs.db: search, filter by source, open the link and apply. Filters live in a popover so the list stays the focus.
export function JobsTab({ onOpened, onResearch }: { onOpened: () => void; onResearch: (company: string, location: string) => void }) {
  const [q, setQ] = useState("")
  const [sources, setSources] = useState<string[]>([])
  const [days, setDays] = useState("0")
  const [confirmedOnly, setConfirmedOnly] = useState(false)
  const [hideFlagged, setHideFlagged] = useState(true)
  const [hideMarked, setHideMarked] = useState(true)
  const [sort, setSort] = useState("fit")
  const [fit, setFit] = useState(true)
  const [maxYears, setMaxYears] = useState("any")   // "any", "0" no experience needed
  const [rows, setRows] = useState<Job[]>([])
  const [meta, setMeta] = useState<Page | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const seq = useRef(0)
  const fetched = useRef(0)  // rows the server has returned so far: the next page starts here, even after a row was hidden locally
  const [showList, setShowList] = useState(false)           // the blacklist editor
  const [listVersion, setListVersion] = useState(0)
  const [ask, setAsk] = useState<string | null>(null)       // the job whose red button was pressed once: pressing again confirms
  const [notice, setNotice] = useState<{ text: string; undo?: { line: number; company: string } } | null>(null)

  const load = useCallback(async (offset: number, replace: boolean) => {
    const mine = ++seq.current
    setLoading(true)
    const res = await api("/jobs", { q, sources, days: Number(days), confirmed_only: confirmedOnly, hide_flagged: hideFlagged, hide_marked: hideMarked, sort, fit, max_years: maxYears === "any" ? "" : maxYears, limit: PAGE, offset })
    if (mine !== seq.current) return // a newer search replaced this one
    setLoading(false)
    if (res.error) { setError(res.error === "server offline" ? "The local server is not running." : String(res.error)); if (replace) { setRows([]); fetched.current = 0 } return }
    setError("")
    setMeta(res)
    fetched.current = (replace ? 0 : offset) + res.rows.length
    setRows((old) => {
      if (replace) return res.rows
      const have = new Set(old.map((x) => x.id))
      return [...old, ...res.rows.filter((x: Job) => !have.has(x.id))]
    })
  }, [q, sources, days, confirmedOnly, hideFlagged, hideMarked, sort, fit, maxYears])

  useEffect(() => { const t = setTimeout(() => load(0, true), q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  // Reading each posting's text for the years it asks for runs on the server; this starts it, shows how far it is, and reloads the list when it ends.
  const [check, setCheck] = useState<Check | null>(null)
  const wasRunning = useRef(false)
  const loadRef = useRef(load)   // the check outlives renders: when it ends it must reload with the filters as they are now, not as they were
  loadRef.current = load
  useEffect(() => {
    if (!fit) return
    let stop = false
    const tick = async (start: boolean) => {
      const r = await api("/jobs/years", { start })
      if (stop || r.error) return
      setCheck(r)
      if (wasRunning.current && !r.running) loadRef.current(0, true)   // finished: the list now hides what needs too many years
      wasRunning.current = !!r.running
    }
    tick(true)
    const t = setInterval(() => tick(false), 3000)
    return () => { stop = true; clearInterval(t) }
  }, [fit])

  const active = sources.length + (days !== "0" ? 1 : 0) + (confirmedOnly ? 1 : 0) + (!hideFlagged ? 1 : 0) + (!hideMarked ? 1 : 0) + (sort !== "fit" ? 1 : 0) + (!fit ? 1 : 0) + (maxYears !== "any" ? 1 : 0)
  const clear = () => { setSources([]); setDays("0"); setConfirmedOnly(false); setHideFlagged(true); setHideMarked(true); setSort("fit"); setFit(true); setMaxYears("any") }

  const open = (j: Job) => { chrome.tabs.create({ url: j.url, active: true }); onOpened() }
  const mark = async (j: Job, m: string) => {
    await api("/jobs/mark", { id: j.id, mark: m })
    setRows((old) => (hideMarked && m ? old.filter((x) => x.id !== j.id) : old.map((x) => (x.id === j.id ? { ...x, mark: m } : x))))
  }

  // Ghost listings: one press asks, a second press blacklists the company (its jobs leave the list and jobs.db, the scanners skip it from now on).
  const blacklist = async (j: Job) => {
    if (ask !== j.id) { setAsk(j.id); setTimeout(() => setAsk((a) => (a === j.id ? null : a)), 4000); return }
    setAsk(null)
    const r = await api("/blacklist/add", { company: j.company, reason: "ghost or repeated listings (added from the Jobs tab)" })
    if (r.error) { setNotice({ text: String(r.error) }); return }
    setNotice({ text: r.added ? `${j.company} is blacklisted${r.removed ? `, ${r.removed} job${r.removed === 1 ? "" : "s"} removed` : ""}.` : `${j.company} was already blacklisted.`, undo: r.added ? { line: r.entry.line, company: r.entry.company } : undefined })
    setListVersion((v) => v + 1)
    load(0, true)
  }
  const undo = async () => {
    if (!notice?.undo) return
    const r = await api("/blacklist/remove", notice.undo)
    setNotice({ text: r.error ? String(r.error) : `${notice.undo.company} is off the list again. Its jobs return on the next scan.` })
    setListVersion((v) => v + 1)
    load(0, true)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search jobs" aria-label="Search jobs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" aria-label="Filters"><Filter />Filters{active > 0 && <Badge className="ml-0.5 h-4 min-w-4 px-1">{active}</Badge>}</Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-[75vh] w-80 space-y-4 overflow-y-auto">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Source</p>
              <ToggleGroup type="multiple" variant="outline" size="sm" className="flex flex-wrap justify-start gap-1.5" value={sources} onValueChange={setSources}>
                {(meta?.facets.sources || []).map(([name, n]) => <ToggleGroupItem key={name} value={name} className="h-7 rounded-full px-2.5 text-xs">{name} <span className="ml-1 text-muted-foreground">{n}</span></ToggleGroupItem>)}
              </ToggleGroup>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">First seen</p>
              <ToggleGroup type="single" variant="outline" size="sm" value={days} onValueChange={(v) => v && setDays(v)}>
                {DAYS.map(([v, name]) => <ToggleGroupItem key={v} value={v} className="text-xs">{name}</ToggleGroupItem>)}
              </ToggleGroup>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Experience asked, in years</p>
              <ToggleGroup type="single" variant="outline" size="sm" className="flex flex-wrap justify-start gap-1.5" value={maxYears} onValueChange={(v) => setMaxYears(v || "any")}>
                {EXPERIENCE.map(([v, name]) => <ToggleGroupItem key={v} value={v} className="text-xs">{name}</ToggleGroupItem>)}
              </ToggleGroup>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Sort</p>
              <ToggleGroup type="single" variant="outline" size="sm" value={sort} onValueChange={(v) => v && setSort(v)}>
                <ToggleGroupItem value="fit" className="text-xs">Best fit</ToggleGroupItem>
                <ToggleGroupItem value="new" className="text-xs">Newest</ToggleGroupItem>
                <ToggleGroupItem value="company" className="text-xs">Company A to Z</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <Separator />
            <label className="flex items-center justify-between gap-3 text-sm">Hide jobs above my level or in other countries<Switch checked={fit} onCheckedChange={setFit} /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Employer page only<Switch checked={confirmedOnly} onCheckedChange={setConfirmedOnly} /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Hide flagged as suspicious<Switch checked={hideFlagged} onCheckedChange={setHideFlagged} /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Hide applied and dismissed<Switch checked={hideMarked} onCheckedChange={setHideMarked} /></label>
            {active > 0 && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
          </PopoverContent>
        </Popover>
        <Button variant="outline" aria-label="Blacklist" aria-pressed={showList} title="Companies you never want to see" onClick={() => setShowList((v) => !v)}><Ban />Blacklist</Button>
      </div>
      {showList && <BlacklistPanel version={listVersion} onChanged={() => load(0, true)} />}
      <ScanBar empty={!!meta && meta.all === 0 && !error} onDone={() => { setListVersion((v) => v + 1); load(0, true) }} />

      {notice && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs" role="status" data-notice>
          <span className="flex-1">{notice.text}</span>
          {notice.undo && <Button size="xs" variant="outline" onClick={undo}>Undo</Button>}
          <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
        </p>
      )}

      {meta && !error && (
        <div className="space-y-1 px-0.5 text-xs text-muted-foreground" data-fit>
          <p>
            {meta.total} {fit ? "fit your level" : "jobs"} of {meta.all}{meta.latest ? `, updated ${age(meta.latest)}` : ""}
          </p>
          {fit && (meta.fit.hidden.senior > 0 || meta.fit.hidden.years > 0 || meta.fit.hidden.location > 0) && (
            <p>Hidden: {meta.fit.hidden.location} in other countries, {meta.fit.hidden.senior} senior titles, {meta.fit.hidden.years} asking for more than {meta.fit.limit} year{meta.fit.limit === 1 ? "" : "s"}{(meta.fit.hidden.experience ?? 0) > 0 ? `, ${meta.fit.hidden.experience} by your experience filter` : ""}. They are hidden, not deleted.</p>
          )}
          {!!meta.fit.hidden.blacklist && <p>{meta.fit.hidden.blacklist} hidden because the company is on your blacklist.</p>}
          {fit && check?.running && <p className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />Reading job descriptions for the years they ask for: {check.done} of {check.total}</p>}
          {fit && !check?.running && meta.fit.unchecked > 0 && <p>{meta.fit.unchecked} jobs have not been read yet (no public description for their site, or still queued).</p>}
          {fit && !check?.running && !!check?.removed && <p>Removed {check.removed} job{check.removed === 1 ? "" : "s"} from the database because their location is in another country or they ask for more than {meta.fit.limit} year{meta.fit.limit === 1 ? "" : "s"} in their own text.</p>}
          {fit && check?.error && <p className="text-warning">{check.error}</p>}
        </div>
      )}
      {error && <p className="rounded-lg border border-warning/50 p-3 text-sm text-warning">{error}</p>}

      <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Jobs">
        {loading && !rows.length && Array.from({ length: 5 }, (_, i) => <li key={i} className="space-y-2 p-3"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></li>)}
        {rows.map((j) => (
          <li key={j.id} className="flex items-start gap-2 p-3 transition-colors hover:bg-accent/40" data-job={j.id}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className={`truncate text-sm font-medium ${j.mark ? "text-muted-foreground line-through" : ""}`} title={j.title}>{j.title}</p>
              <p className="truncate text-xs text-muted-foreground">{[j.company, j.location].filter(Boolean).join(", ")}</p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {j.entry && <Badge variant="outline" className="border-success/40 text-success">Entry level</Badge>}
                {j.years && <Badge variant="outline" className="font-normal">Asks {j.years} yrs</Badge>}
                {j.confirmed && <Badge variant="outline" className="border-success/40 text-success"><Check className="size-3" />Employer page</Badge>}
                {j.sources.slice(0, 2).map((s) => <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>)}
                {j.sources.length > 2 && <span className="text-xs text-muted-foreground">+{j.sources.length - 2}</span>}
                {j.flags.length > 0 && <Badge variant="outline" className="border-warning/50 text-warning" title={j.flags.join("; ")}><ShieldAlert className="size-3" />Check</Badge>}
                {j.mark && <Badge variant="outline">{j.mark}</Badge>}
                <span className="text-xs text-muted-foreground">{age(j.first_seen)}{j.stipend ? `, ${j.stipend}` : ""}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="xs" onClick={() => open(j)}>Open</Button>
              <Button size={ask === j.id ? "xs" : "icon-xs"} variant={ask === j.id ? "destructive" : "ghost"} className={ask === j.id ? "" : "text-destructive hover:text-destructive"}
                      aria-label={ask === j.id ? `Confirm: blacklist ${j.company}` : `Blacklist ${j.company}`} title={`Never show ${j.company} again (ghost or repeated listings)`} data-blacklist-job={j.id}
                      onClick={() => blacklist(j)}>
                <Ban />{ask === j.id && "Confirm"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" aria-label="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => mark(j, "applied")}>Mark as applied</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mark(j, "saved")}>Save for later</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mark(j, "dismissed")}>Not interested</DropdownMenuItem>
                  {j.mark && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => mark(j, "")}>Clear mark</DropdownMenuItem></>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onResearch(j.company, j.location)}>Research {j.company}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => { navigator.clipboard.writeText(j.url).catch(() => setNotice({ text: "Chrome blocked copying the link." })) }}>Copy link</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
        {!loading && !rows.length && !error && <li className="p-6 text-center text-sm text-muted-foreground">No jobs match. Try fewer filters.</li>}
      </ul>

      {meta && fetched.current < meta.total && (
        <Button variant="outline" className="w-full" disabled={loading} onClick={() => load(fetched.current, false)}>
          {loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}Show more ({Math.max(0, meta.total - fetched.current)} left)
        </Button>
      )}
    </div>
  )
}

// Runs the job scanners on this Mac and shows their progress. It keeps going if the panel is closed; reopening shows where it is.
function ScanBar({ empty, onDone }: { empty: boolean; onDone: () => void }) {
  const [s, setS] = useState<any>(null)
  const wasRunning = useRef(false)
  const poll = useCallback(async () => { const r = await api("/scan/status", {}); if (!r.error) setS(r); return r }, [])
  useEffect(() => { poll() }, [poll])
  useEffect(() => {
    if (!s?.running) { if (wasRunning.current) { wasRunning.current = false; onDone() } return }
    wasRunning.current = true
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
  }, [s?.running, poll, onDone])
  const start = async () => { const r = await api("/scan/start", {}); if (r.error) setS((x: any) => ({ ...x, error: r.error, running: false })); else setS(r) }
  if (!s) return null
  return (
    <div className="space-y-2">
      {empty && !s.running && <p className="text-sm text-muted-foreground">No jobs yet. Press the button and Apply searches the job boards for your roles. The first search takes several minutes, and you can close this panel meanwhile.</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" variant={empty ? "default" : "outline"} disabled={s.running || !s.can} onClick={start}>{s.running ? "Searching" : empty ? "Find jobs" : "Find new jobs"}</Button>
        {s.running && <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 shrink-0 animate-spin" /><span className="truncate">{s.line}</span></span>}
        {!s.running && s.finished > 0 && s.ok && <span className="text-xs text-muted-foreground">Search finished.</span>}
      </div>
      {!s.can && s.why && <p className="text-xs text-warning">{s.why}</p>}
      {(s.error || (!s.running && s.finished > 0 && s.ok === false)) && <p className="text-xs text-warning">{s.error || "The search stopped with an error."}</p>}
    </div>
  )
}

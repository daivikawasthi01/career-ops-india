import { useCallback, useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Filter, Loader2, MoreHorizontal, Search, ShieldAlert } from "lucide-react"
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

type Job = { id: string; url: string; company: string; title: string; location: string; first_seen: string; sources: string[]; confirmed: boolean; flags: string[]; mark: string; stipend: string }
type Page = { total: number; all: number; latest: string; rows: Job[]; facets: { sources: [string, number][]; marked: number } }
const PAGE = 40
const DAYS: [string, string][] = [["0", "Any time"], ["1", "Today"], ["3", "3 days"], ["7", "7 days"]]

const age = (d: string) => {
  const n = Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000)
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
  const [sort, setSort] = useState("new")
  const [rows, setRows] = useState<Job[]>([])
  const [meta, setMeta] = useState<Page | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const seq = useRef(0)

  const load = useCallback(async (offset: number, replace: boolean) => {
    const mine = ++seq.current
    setLoading(true)
    const res = await api("/jobs", { q, sources, days: Number(days), confirmed_only: confirmedOnly, hide_flagged: hideFlagged, hide_marked: hideMarked, sort, limit: PAGE, offset })
    if (mine !== seq.current) return // a newer search replaced this one
    setLoading(false)
    if (res.error) { setError(res.error === "server offline" ? "The local server is not running." : String(res.error)); return }
    setError("")
    setMeta(res)
    setRows((old) => (replace ? res.rows : [...old, ...res.rows]))
  }, [q, sources, days, confirmedOnly, hideFlagged, hideMarked, sort])

  useEffect(() => { const t = setTimeout(() => load(0, true), q ? 250 : 0); return () => clearTimeout(t) }, [load, q])

  const active = sources.length + (days !== "0" ? 1 : 0) + (confirmedOnly ? 1 : 0) + (!hideFlagged ? 1 : 0) + (!hideMarked ? 1 : 0) + (sort !== "new" ? 1 : 0)
  const clear = () => { setSources([]); setDays("0"); setConfirmedOnly(false); setHideFlagged(true); setHideMarked(true); setSort("new") }

  const open = (j: Job) => { chrome.tabs.create({ url: j.url, active: true }); onOpened() }
  const mark = async (j: Job, m: string) => {
    await api("/jobs/mark", { id: j.id, mark: m })
    setRows((old) => (hideMarked && m ? old.filter((x) => x.id !== j.id) : old.map((x) => (x.id === j.id ? { ...x, mark: m } : x))))
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search title, company or city" aria-label="Search jobs" value={q} onChange={(e) => setQ(e.target.value)} />
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
              <p className="text-xs font-medium text-muted-foreground">Sort</p>
              <ToggleGroup type="single" variant="outline" size="sm" value={sort} onValueChange={(v) => v && setSort(v)}>
                <ToggleGroupItem value="new" className="text-xs">Newest</ToggleGroupItem>
                <ToggleGroupItem value="company" className="text-xs">Company A to Z</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <Separator />
            <label className="flex items-center justify-between gap-3 text-sm">Employer page only<Switch checked={confirmedOnly} onCheckedChange={setConfirmedOnly} /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Hide flagged as suspicious<Switch checked={hideFlagged} onCheckedChange={setHideFlagged} /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Hide applied and dismissed<Switch checked={hideMarked} onCheckedChange={setHideMarked} /></label>
            {active > 0 && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
          </PopoverContent>
        </Popover>
      </div>

      {meta && !error && (
        <p className="px-0.5 text-xs text-muted-foreground">
          {meta.total} of {meta.all} jobs{meta.latest ? `, updated ${age(meta.latest)}` : ""}
          {meta.facets.marked > 0 && !hideMarked ? "" : ""}
        </p>
      )}
      {error && <p className="rounded-lg border border-warning/50 p-3 text-sm text-warning">{error}</p>}

      <ul className="divide-y rounded-xl border" aria-label="Jobs">
        {loading && !rows.length && Array.from({ length: 5 }, (_, i) => <li key={i} className="space-y-2 p-3"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></li>)}
        {rows.map((j) => (
          <li key={j.id} className="flex items-start gap-2 p-3" data-job={j.id}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className={`truncate text-sm font-medium ${j.mark ? "text-muted-foreground line-through" : ""}`} title={j.title}>{j.title}</p>
              <p className="truncate text-xs text-muted-foreground">{[j.company, j.location].filter(Boolean).join(" · ")}</p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {j.confirmed && <Badge variant="outline" className="border-success/40 text-success"><Check className="size-3" />Employer page</Badge>}
                {j.sources.slice(0, 2).map((s) => <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>)}
                {j.sources.length > 2 && <span className="text-xs text-muted-foreground">+{j.sources.length - 2}</span>}
                {j.flags.length > 0 && <Badge variant="outline" className="border-warning/50 text-warning" title={j.flags.join("; ")}><ShieldAlert className="size-3" />Check</Badge>}
                {j.mark && <Badge variant="outline">{j.mark}</Badge>}
                <span className="text-xs text-muted-foreground">{age(j.first_seen)}{j.stipend ? ` · ${j.stipend}` : ""}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="xs" onClick={() => open(j)}>Open</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" aria-label="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => mark(j, "applied")}>Mark as applied</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mark(j, "saved")}>Save for later</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => mark(j, "dismissed")}>Not interested</DropdownMenuItem>
                  {j.mark && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => mark(j, "")}>Clear mark</DropdownMenuItem></>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onResearch(j.company, j.location)}>Research {j.company}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(j.url)}>Copy link</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
        {!loading && !rows.length && !error && <li className="p-6 text-center text-sm text-muted-foreground">No jobs match. Try fewer filters.</li>}
      </ul>

      {meta && rows.length < meta.total && (
        <Button variant="outline" className="w-full" disabled={loading} onClick={() => load(rows.length, false)}>
          {loading ? <Loader2 className="animate-spin" /> : <ChevronDown />}Show more ({meta.total - rows.length} left)
        </Button>
      )}
    </div>
  )
}

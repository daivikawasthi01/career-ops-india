import { useEffect, useReducer, useRef, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { send } from "@/lib/chrome"
import { currentTheme, toggleTheme } from "@/lib/theme"
import { AttentionCards, CvCard, FilledCard, Footer, Group, JobCard, NeedsCard, OldManifestCard, SetupCard, SiteCard, StaleCard, SummaryCard, VerdictBanner, framesItems } from "./cards"
import { CompanyTab } from "./CompanyTab"
import { JobsTab } from "./JobsTab"
import { usePanel } from "./usePanel"

const oldManifest = () => !!window.AF_BUILD && chrome.runtime.getManifest().version !== window.AF_BUILD

export function App() {
  const p = usePanel()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const drafts = useRef<Record<string, string>>({}) // edits to a suggestion that is not applied yet survive a redraw
  const { st } = p
  const [tab, setTab] = useState("page")
  const [seed, setSeed] = useState({ company: "", location: "" }) // a company (and its job city) chosen in the Jobs tab
  // A lookup finished while the panel was closed: open on the Company tab, where the answer is waiting.
  useEffect(() => { send("clear-badge").then((r: any) => { if (r?.had) setTab("company") }).catch(() => {}) }, [])

  const llm = st?.server?.llm
  const header = (
    <header className="flex items-center justify-between gap-2 pb-1">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight">Apply</h1>
        {st && !st.error && <Badge variant="outline" data-ok={String(!!llm?.ok)} className={llm?.ok ? "border-success/40 text-success" : "border-warning/50 text-warning"}>{llm?.ok ? `Models ready: ${llm.chat_model}` : "No model available"}</Badge>}
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Toggle theme" onClick={() => { toggleTheme(); rerender() }}>{currentTheme() === "dark" ? <Sun /> : <Moon />}</Button>
    </header>
  )

  let body: React.ReactNode
  if (!st) body = <div className="space-y-3" id="boot"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>
  else if (st.error) body = <SetupCard p={p} />
  else if (!st.host) body = <p className="px-1 py-6 text-center text-sm text-muted-foreground">Open an application form and I will pick it up.</p>
  else {
    const all = framesItems(st)
    const ready = all.filter((i: any) => i.status === "fill" || i.status === "resume")
    const needs = all.filter((i: any) => ["draftable", "drafting", "draft", "unknown", "manual", "offline", "cover"].includes(i.status))
    const d = (Object.values(st.frames || {}) as any[]).map((f) => f.diag).find((x) => x && x.inputs !== undefined)
    const mine = chrome.runtime.getManifest().version
    const stale = st.injected && (Object.values(st.frames || {}) as any[]).some((f) => f.diag?.v !== mine)
    const live = st.siteMode !== "off" && st.injected
    body = (
      <div className="space-y-3">
        {stale && <StaleCard p={p} />}
        {live && <VerdictBanner p={p} />}
        <SiteCard p={p} />
        {live && <JobCard p={p} />}
        {st.siteMode === "assist" && all.length > 0 && <>
          <SummaryCard p={p} all={all} />
          <AttentionCards p={p} />
          <Group title="Needs you">{needs.map((i: any) => <NeedsCard key={`${i.frameId}:${i.id}`} p={p} i={i} drafts={drafts.current} />)}</Group>
          <Group title="Ready">{ready.map((i: any) => <FilledCard key={`${i.frameId}:${i.id}`} p={p} i={i} />)}</Group>
        </>}
        {st.siteMode === "assist" && all.length === 0 && <>
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">{st.injected ? "No application form on this page yet." : "Open an application form and I will pick it up."}</p>
          {d && <p className="px-1 text-center text-xs text-muted-foreground">{d.error ? `Scan failed: ${d.error}` : `Seen on this page: ${d.inputs} fields, ${d.readable} readable (needs 3).`}</p>}
        </>}
        <CvCard p={p} />
        <Footer p={p} rerender={rerender} />
      </div>
    )
  }

  return (
    <main className="mx-auto w-full max-w-xl space-y-3 p-3" aria-live="polite" id="app">
      {header}
      {oldManifest() && <OldManifestCard />}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full" aria-label="Sections">
          <TabsTrigger value="page">Page</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="company">Company</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "page" && body}
      {tab === "jobs" && <JobsTab onOpened={() => setTab("page")} onResearch={(c, l) => { setSeed({ company: c, location: l }); setTab("company") }} />}
      {tab === "company" && <CompanyTab key={seed.company + "|" + seed.location} seed={seed} />}
    </main>
  )
}

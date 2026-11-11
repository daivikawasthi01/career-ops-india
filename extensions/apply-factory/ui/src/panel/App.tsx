import { useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { send } from "@/lib/chrome"
import { AttentionCards, FilledCard, Footer, Group, JobCard, NeedsCard, OldManifestCard, SetupCard, SiteCard, StaleCard, SubmittedCard, SummaryCard, VerdictBanner, framesItems, goTab } from "./cards"
import { CompanyTab } from "./CompanyTab"
import { JobsTab } from "./JobsTab"
import { YouTab } from "./YouTab"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { usePanel } from "./usePanel"

const oldManifest = () => !!window.AF_BUILD && chrome.runtime.getManifest().version !== window.AF_BUILD

export function App() {
  const p = usePanel()
  const drafts = useRef<Record<string, string>>({}) // edits to a suggestion that is not applied yet survive a redraw
  const { st } = p
  const [tab, setTab] = useState("page")
  // A tab is built the first time it is opened and then only hidden, never removed: a search, a draft or an email check that takes minutes keeps running
  // and keeps its result while you look at another tab.
  const [seen, setSeen] = useState<Set<string>>(new Set(["page"]))
  useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))) }, [tab])
  const show = (name: string) => (tab === name ? "" : "hidden")
  const [seed, setSeed] = useState({ company: "", location: "" }) // a company (and its job city) chosen in the Jobs tab
  // A lookup finished while the panel was closed: open on the Company tab, where the answer is waiting.
  useEffect(() => {
    const go = (e: Event) => setTab(String((e as CustomEvent).detail))
    window.addEventListener("af-goto", go)
    return () => window.removeEventListener("af-goto", go)
  }, [])
  useEffect(() => { send("clear-badge").then((r: any) => { if (r?.had) setTab("company") }).catch(() => {}) }, [])

  const llm = st?.server?.llm
  const header = (
    <header className="sticky top-0 z-20 -mx-3 -mt-3 space-y-2 border-b bg-background/85 px-3 pt-3 backdrop-blur-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground" aria-hidden><Check className="size-4" strokeWidth={3} /></span>
          <h1 className="text-base font-semibold tracking-tight">Apply</h1>
          {st && !st.error && (
            <span data-ok={String(!!llm?.ok)} title={llm?.ok ? "A model is available for drafts" : "Saved answers still fill; drafts need a model"}
              className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${llm?.ok ? "border-success/30 text-success" : "border-warning/40 text-warning"}`}>
              <span className="truncate">{llm?.ok ? llm.chat_model : "no model"}</span>
            </span>
          )}
        </div>
        <ThemeToggle />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="w-full justify-start px-0" aria-label="Sections">
          <TabsTrigger value="page">Page</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="you">You</TabsTrigger>
        </TabsList>
      </Tabs>
    </header>
  )

  let body: React.ReactNode
  if (!st) body = <div className="space-y-3" id="boot"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>
  else if (st.error) body = <SetupCard p={p} />
  else if (!st.host) body = <p className="px-1 py-6 text-center text-sm text-muted-foreground">Open a job application and Apply fills the answers it already knows.</p>
  else {
    const all = framesItems(st)
    const ready = all.filter((i: any) => i.status === "fill" || i.status === "resume")
    const needs = all.filter((i: any) => ["draftable", "drafting", "draft", "unknown", "manual", "offline", "cover"].includes(i.status))
    const d = (Object.values(st.frames || {}) as any[]).map((f) => f.diag).find((x) => x && x.inputs !== undefined)
    const mine = chrome.runtime.getManifest().version
    const stale = st.injected && (Object.values(st.frames || {}) as any[]).some((f) => f.diag?.v !== mine)
    const setup = st.server?.setup
    const live = st.siteMode !== "off" && st.injected
    body = (
      <div className="space-y-3">
        {stale && <StaleCard p={p} />}
        <SubmittedCard p={p} />
        {setup && !setup.ready && (
          <Card size="sm"><CardContent className="flex items-center justify-between gap-3">
            <p className="text-sm">Finish setup to fill forms.</p>
            <Button size="xs" onClick={() => goTab("you")}>Open setup</Button>
          </CardContent></Card>
        )}
        <SiteCard p={p} />
        {st.siteMode === "assist" && all.length > 0 && <SummaryCard p={p} all={all} />}
        {live && <VerdictBanner p={p} />}
        {live && <JobCard p={p} />}
        {st.siteMode === "assist" && all.length > 0 && <>
          <AttentionCards p={p} />
          <Group title="Needs you">{needs.map((i: any) => <NeedsCard key={`${i.frameId}:${i.id}`} p={p} i={i} drafts={drafts.current} />)}</Group>
          <Group title="Ready">{ready.map((i: any) => <FilledCard key={`${i.frameId}:${i.id}`} p={p} i={i} />)}</Group>
        </>}
        {st.siteMode === "assist" && all.length === 0 && <>
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">{st.injected ? "No application form on this page yet." : "Open an application form and I will pick it up."}</p>
          {d && <p className="px-1 text-center text-xs text-muted-foreground">{d.error ? `Scan failed: ${d.error}` : `Seen on this page: ${d.inputs} fields, ${d.readable} readable (needs 3).`}</p>}
        </>}
        <Footer p={p} />
      </div>
    )
  }

  return (
    <main className="mx-auto w-full max-w-xl space-y-3 p-3 pt-3" id="app">
      {header}
      {oldManifest() && <OldManifestCard />}
      <div className={show("page")}>{body}</div>
      {seen.has("jobs") && <div className={show("jobs")}><JobsTab onOpened={() => setTab("page")} onResearch={(c, l) => { setSeed({ company: c, location: l }); setTab("company") }} /></div>}
      {seen.has("you") && <div className={show("you")}><YouTab p={p} /></div>}
      {seen.has("company") && <div className={show("company")}><CompanyTab key={seed.company + "|" + seed.location} seed={seed} /></div>}
    </main>
  )
}

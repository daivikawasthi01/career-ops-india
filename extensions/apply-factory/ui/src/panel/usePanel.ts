import { useCallback, useEffect, useRef, useState } from "react"
import { api, send as rawSend } from "@/lib/chrome"

// Everything the panel knows. The old vanilla panel kept these in module variables and redrew by hand; here they are React state.
export type Job = { key: string; ctx: any; pre: any; score: any; busy: string; confirm: boolean; result: string; error: string; autoDone: boolean; showScore: boolean }
const blankJob = (key = ""): Job => ({ key, ctx: null, pre: null, score: null, busy: "", confirm: false, result: "", error: "", autoDone: false, showScore: false })
const scoreMemo = new Map<string, any>() // a score is kept per job, so moving between the steps of one application never scores it again

export function usePanel() {
  const [st, setSt] = useState<any>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  const [job, setJob] = useState<Job>(blankJob())
  const [notice, setNotice] = useState("")
  const [siteNote, setSiteNote] = useState("")
  const [covers, setCovers] = useState<Record<string, any>>({})
  const tab = useRef<number | null>(null)
  const jobRef = useRef(job)
  jobRef.current = job
  const patchJob = useCallback((p: Partial<Job>) => setJob((j) => ({ ...j, ...p })), [])

  const send = useCallback((type: string, extra: Record<string, any> = {}) => rawSend(type, { tabId: tab.current, ...extra }), [])
  const callApi = api

  const jobContext = useCallback(async () => {
    if (jobRef.current.ctx) return jobRef.current.ctx
    const ctx = await send("job-context")
    jobRef.current = { ...jobRef.current, ctx }
    setJob((j) => ({ ...j, ctx }))
    return ctx
  }, [send])

  const runChecks = useCallback(async () => {
    patchJob({ busy: "checks", error: "" })
    const ctx = await jobContext()
    const res = await callApi("/preflight", { url: ctx.url, title: ctx.title, company: ctx.company })
    patchJob({ pre: res.error ? null : res, error: res.error || "", busy: "" })
  }, [jobContext, patchJob])

  const runScore = useCallback(async (auto = false) => {
    patchJob({ busy: "score", error: "" })
    const ctx = await jobContext()
    const memoKey = ctx.jd_key + "|" + ctx.title
    if (auto && ctx.jd_text.length < 600) { patchJob({ busy: "", autoDone: true }); return } // not a job posting: stay quiet
    const res = scoreMemo.get(memoKey) || (await callApi("/score", { title: ctx.title, company: ctx.company, jd_text: ctx.jd_text }))
    if (!res.error) scoreMemo.set(memoKey, res)
    patchJob({ score: res.error ? null : res, error: auto ? "" : res.error || "", autoDone: true, busy: "" })
  }, [jobContext, patchJob])

  const refresh = useCallback(async () => {
    const forced = Number(new URLSearchParams(location.search).get("tab")) // lets the e2e test point the panel at another tab
    const [t] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true })
    if (!t) return
    tab.current = t.id ?? null
    setTabId(tab.current)
    let next = await send("get-state")
    if (!next || next.error === "no reply") next = { error: "server offline" }
    const key = `${next.host}|${(Object.values(next.frames || {})[0] as any)?.url || ""}`
    if (key !== jobRef.current.key) { const fresh = blankJob(key); jobRef.current = fresh; setJob(fresh) }
    setSt(next)
    const j = jobRef.current
    if (next.injected && next.siteMode !== "off" && next.server?.llm?.ok && !j.score && !j.busy && !j.autoDone) runScore(true)
  }, [send, runScore])

  useEffect(() => {
    // Tell the background this window's side panel is open (the copy drawn inside a web page is an iframe and does not count).
    // The port reconnects if the background worker was restarted.
    if (window === window.top) {
      const announce = async () => {
        const win = await chrome.windows.getCurrent().catch(() => null)
        if (!win) return
        const port = chrome.runtime.connect({ name: "sidepanel" })
        port.postMessage({ windowId: win.id })
        port.onDisconnect.addListener(() => setTimeout(announce, 500))
      }
      announce()
    }
    let timer: ReturnType<typeof setTimeout>
    const soon = () => { clearTimeout(timer); timer = setTimeout(refresh, 120) }
    const onMsg = (m: any) => { if (m.type === "state-changed") soon() }
    const onUpdated = (_id: number, info: any) => { if (info.status === "complete") soon() }
    chrome.runtime.onMessage.addListener(onMsg)
    chrome.tabs.onActivated.addListener(soon)
    chrome.tabs.onUpdated.addListener(onUpdated)
    const every = setInterval(refresh, 15000)
    refresh()
    return () => {
      clearTimeout(timer); clearInterval(every)
      chrome.runtime.onMessage.removeListener(onMsg)
      chrome.tabs.onActivated.removeListener(soon)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [refresh])

  return { st, tabId, job, patchJob, notice, setNotice, siteNote, setSiteNote, covers, setCovers, send, callApi, refresh, jobContext, runChecks, runScore }
}

export type Panel = ReturnType<typeof usePanel>

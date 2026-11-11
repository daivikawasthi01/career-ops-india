// Thin wrappers over the extension messaging the old panel used. Every reply is plain JSON from the background worker.
export type Msg = Record<string, any>

export const send = (type: string, extra: Msg = {}): Promise<any> => chrome.runtime.sendMessage({ type, ...extra })
// Never rejects and never returns nothing: a background script that predates this panel (the extension was updated but not reloaded) does not
// know a new path and answers nothing, which would leave a spinner running forever.
export const api = async (path: string, body: Msg = {}): Promise<any> => {
  try {
    const r = await chrome.runtime.sendMessage({ type: "api", path, body })
    return r ?? { error: "The extension's background script did not answer. Reload the extension at chrome://extensions, then reopen the panel." }
  } catch (e) {
    return { error: `The extension's background script did not answer (${e instanceof Error ? e.message : e}). Reload the extension at chrome://extensions.` }
  }
}

declare global {
  interface Window { AF_BUILD?: string; AF_SERVER_CMD?: string }
}

export const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(",")[1])
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

// Long server jobs (company research, mail checks) return an id; this polls /cv/job until it finishes or the wait runs out.
export async function pollJob(id: string, maxSeconds = 240): Promise<any> {
  const until = Date.now() + maxSeconds * 1000
  while (Date.now() < until) {
    const j = await api("/cv/job", { id })
    if (j.error && !j.status) return { status: "error", error: j.error }
    if (j.status !== "running") return j
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { status: "error", error: "Still running after a few minutes. Try again later." }
}

import { useCallback, useEffect, useState } from "react"
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/chrome"

export type BlacklistEntry = { line: number; company: string; since: string; scope: string; reason: string }

// The do-not-apply list (career-ops' data/blacklist.md). Every row can be corrected or taken off again; the scanners read the same file.
export function BlacklistPanel({ onChanged, version }: { onChanged: () => void; version: number }) {
  const [entries, setEntries] = useState<BlacklistEntry[] | null>(null)
  const [error, setError] = useState("")
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    const r = await api("/blacklist/list", {})
    if (r.error) { setError(String(r.error)); return }
    setError(""); setEntries(r.entries)
  }, [])
  useEffect(() => { load() }, [load, version])

  const run = async (path: string, body: object, done: string) => {
    setBusy(true); setError(""); setNote("")
    const r = await api(path, body)
    setBusy(false)
    if (r.error) { setError(String(r.error)); load(); return }
    setEditing(null); setNote(done); await load(); onChanged()
  }

  return (
    <section className="space-y-2 rounded-xl border p-3" aria-label="Blacklist" data-blacklist>
      <p className="text-xs text-muted-foreground">
        Companies you never want to see. The scanners skip them too (data/blacklist.md). Removing one lets its jobs come back on the next scan.
      </p>
      {entries === null && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {entries?.length === 0 && <p className="text-sm text-muted-foreground">Nothing blacklisted yet. Use the red button on a job to add its company.</p>}
      <ul className="divide-y">
        {entries?.map((e) => (
          <li key={e.line} className="flex items-start gap-2 py-2" data-entry={e.company}>
            {editing === e.line ? (
              <form className="flex min-w-0 flex-1 flex-col gap-1.5" onSubmit={(ev) => { ev.preventDefault(); run("/blacklist/update", { line: e.line, company_was: e.company, company: name, reason }, "Saved.") }}>
                <Input aria-label="Company" value={name} onChange={(ev) => setName(ev.target.value)} />
                <Input aria-label="Reason" placeholder="Why (optional)" value={reason} onChange={(ev) => setReason(ev.target.value)} />
                <div className="flex gap-1.5">
                  <Button size="xs" type="submit" disabled={busy || !name.trim()}><Check />Save</Button>
                  <Button size="xs" type="button" variant="ghost" onClick={() => setEditing(null)}><X />Cancel</Button>
                </div>
              </form>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={e.company}>{e.company}{e.scope === "domain" ? " (website)" : ""}</p>
                  <p className="truncate text-xs text-muted-foreground" title={e.reason}>{[e.since, e.reason].filter(Boolean).join(", ")}</p>
                </div>
                <Button size="icon-xs" variant="ghost" aria-label={`Edit ${e.company}`} onClick={() => { setEditing(e.line); setName(e.company); setReason(e.reason) }}><Pencil /></Button>
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${e.company} from the blacklist`} disabled={busy} onClick={() => run("/blacklist/remove", { line: e.line, company: e.company }, `${e.company} is off the list.`)}><Trash2 /></Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-success" role="status">{note}</p>}
      {error && <p className="text-xs text-warning" role="alert">{error}</p>}
    </section>
  )
}

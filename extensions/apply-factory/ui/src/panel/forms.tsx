import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/chrome"
import type { Panel } from "./usePanel"

type Field = { key: string; label: string; value: string; required: boolean }

export function Hint({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <p className={`text-xs leading-relaxed ${warn ? "text-warning" : "text-muted-foreground"}`}>{children}</p>
}

export function Details({ p }: { p: Panel }) {
  const [fields, setFields] = useState<Field[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [note, setNote] = useState("")
  const load = useCallback(async () => {
    const res = await api("/facts", {})
    if (res.error) { setNote(res.error); return }
    setFields(res.fields); setValues(Object.fromEntries(res.fields.map((f: Field) => [f.key, f.value])))
  }, [])
  useEffect(() => { load() }, [load])
  if (!fields) return <Hint>{note || "Loading your details."}</Hint>
  const dirty = fields.filter((f) => (values[f.key] ?? "") !== f.value)
  const save = async () => {
    setNote("")
    const res = await api("/facts", { values: Object.fromEntries(dirty.map((f) => [f.key, values[f.key] ?? ""])) })
    if (res.error) { setNote(res.error); return }
    setNote("Saved."); await load(); p.refresh()
  }
  return (
    <>
      <Hint>Filled into forms without asking. Leave one empty to be asked instead.</Hint>
      {fields.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-xs text-muted-foreground">{f.label}{f.required ? " (needed)" : ""}</span>
          <Input value={values[f.key] ?? ""} onChange={(e) => { setNote(""); setValues((v) => ({ ...v, [f.key]: e.target.value })) }} />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!dirty.length} onClick={save}>Save details</Button>
        {note && <Hint warn={note !== "Saved."}>{note}</Hint>}
      </div>
    </>
  )
}

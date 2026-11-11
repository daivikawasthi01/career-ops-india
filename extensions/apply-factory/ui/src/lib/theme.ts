import { useSyncExternalStore } from "react"

// A saved choice wins; with none, the panel follows the operating system (as the ihatepdf sample does). The choice is kept in this
// page's localStorage and mirrored to chrome.storage.local (key afTheme) so the widgets drawn on web pages can match it.
const KEY = "af-theme"
export type Theme = "dark" | "light"

const saved = (): Theme | null => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null } catch { return null }
}
const system = (): Theme => (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")

export function currentTheme(): Theme { return saved() ?? system() }

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function applyTheme(t: Theme = currentTheme()) {
  document.documentElement.classList.toggle("dark", t === "dark")
  document.documentElement.style.colorScheme = t
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark"
  try { localStorage.setItem(KEY, next) } catch { /* private window: the choice lasts for this page only */ }
  try { chrome.storage?.local.set({ afTheme: next }).catch(() => {}) } catch { /* not an extension page */ }
  applyTheme(next)
  emit()
  return next
}

// Keep the page in step with the OS while no choice is saved, and pick up a choice made in another copy of the panel.
export function watchTheme() {
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => { if (!saved()) { applyTheme(); emit() } })
  window.addEventListener("storage", (e) => { if (e.key === KEY) { applyTheme(); emit() } })
}

export function useTheme(): [Theme, () => Theme] {
  const theme = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, currentTheme)
  return [theme, toggleTheme]
}

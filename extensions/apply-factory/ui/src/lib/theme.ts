// Dark by default; the choice is kept per browser profile. Applied before the first paint so there is no flash.
const KEY = "af-theme"
export type Theme = "dark" | "light"

export function currentTheme(): Theme {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark" } catch { return "dark" }
}

export function applyTheme(t: Theme = currentTheme()) {
  document.documentElement.classList.toggle("dark", t === "dark")
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark"
  try { localStorage.setItem(KEY, next) } catch { /* private window: the choice lasts for this page only */ }
  applyTheme(next)
  return next
}

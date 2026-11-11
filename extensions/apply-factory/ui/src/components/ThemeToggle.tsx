import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/lib/theme"

export function ThemeToggle() {
  const [theme, toggle] = useTheme()
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Toggle theme" title={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"} onClick={toggle}>
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  )
}

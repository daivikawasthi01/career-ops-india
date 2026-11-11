import { createRoot } from "react-dom/client"
import "@/index.css"
import { applyTheme, watchTheme } from "@/lib/theme"
import { App } from "./App"

applyTheme()
watchTheme()
createRoot(document.getElementById("root")!).render(<App />)

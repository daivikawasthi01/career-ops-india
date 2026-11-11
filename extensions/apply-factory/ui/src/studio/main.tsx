import { createRoot } from "react-dom/client"
import "@/index.css"
import { applyTheme } from "@/lib/theme"
import { App } from "./App"

applyTheme()
createRoot(document.getElementById("root")!).render(<App />)

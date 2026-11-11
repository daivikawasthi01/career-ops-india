import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { rmSync } from "node:fs"

// Two extension pages (the side panel / in-page dock, and the CV studio), built into ../browser/app next to the unpacked extension.
export default defineConfig({
  base: "./",
  // The output folder also holds config.js, which browser/build.py writes (server command and build number). Emptying the whole folder deleted it
  // and broke the panel, so only the hashed assets are cleared here.
  plugins: [react(), tailwindcss(), { name: "clean-assets-only", buildStart() { rmSync(path.resolve(__dirname, "../browser/app/assets"), { recursive: true, force: true }) } }],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    outDir: "../browser/app", emptyOutDir: false, target: "es2022", cssCodeSplit: false, modulePreload: false,
    rollupOptions: { input: { panel: path.resolve(__dirname, "panel.html"), studio: path.resolve(__dirname, "studio.html") } },
  },
})

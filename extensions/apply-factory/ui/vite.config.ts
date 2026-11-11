import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// Two extension pages (the side panel / in-page dock, and the CV studio), built into ../browser/app next to the unpacked extension.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    outDir: "../browser/app", emptyOutDir: true, target: "es2022", cssCodeSplit: false, modulePreload: false,
    rollupOptions: { input: { panel: path.resolve(__dirname, "panel.html"), studio: path.resolve(__dirname, "studio.html") } },
  },
})

import { fileURLToPath, URL } from "node:url"
import process from "node:process"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri sets TAURI_ENV_PLATFORM for its dev/build commands; plain `vite`
  // (browser preview, Playwright) keeps the in-memory mock backend.
  define: { __VIDRA_MOCK__: JSON.stringify(!process.env.TAURI_ENV_PLATFORM) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  envPrefix: ["VITE_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022", sourcemap: false },
})

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const daemon = "http://127.0.0.1:7717";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "../../dist/ui"),
    emptyOutDir: true,
    // xterm dominates the bundle; it is served locally, so size warnings are noise here.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    // changeOrigin rewrites Host to the daemon's (its DNS-rebinding guard rejects others); the
    // browser's Origin stays http://localhost:5173, which must be in config.extra_origins.
    proxy: {
      "/api": { target: daemon, ws: true, changeOrigin: true },
      "/auth": { target: daemon, changeOrigin: true },
    },
  },
});

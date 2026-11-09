import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app always calls the API at the relative path /api, so the same build works
// everywhere: Vite's dev server proxies it here, nginx proxies it in Docker
// Compose, and the Kubernetes Gateway routes it on DigitalOcean.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.API_PROXY_TARGET || "http://localhost:3000", changeOrigin: true },
    },
  },
});

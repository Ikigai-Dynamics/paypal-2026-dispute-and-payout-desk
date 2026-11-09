import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// the server keeps serving exactly /app.js and /app.css from dist/public
export default defineConfig({
  plugins: [react()],
  root: "web",
  // dev only: the live cluster desk answers by Host on Traefik
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18080",
        changeOrigin: false,
        headers: { Host: "desk.dispute-and-payout-desk.localhost" },
      },
    },
  },
  base: "/",
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.css",
        inlineDynamicImports: true,
      },
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// the server keeps serving exactly /app.js and /app.css from dist/public
export default defineConfig({
  plugins: [react()],
  root: "web",
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

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/**/*.test.tsx"],
    setupFiles: ["web/src/test-setup.ts"],
  },
});

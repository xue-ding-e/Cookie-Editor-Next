import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Node-native harnesses run separately in CI; keep all upstream Vitest discovery.
    exclude: [...configDefaults.exclude, "tests/**/*.test.mjs"],
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.js",
  },
});

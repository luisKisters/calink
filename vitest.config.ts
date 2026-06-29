import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    globals: true,
    testTimeout: 20_000,
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
  },
});

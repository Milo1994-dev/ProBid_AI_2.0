import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "server/__tests__/**/*.test.ts"],
    testTimeout: 10000,
  },
});

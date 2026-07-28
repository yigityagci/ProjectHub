import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});

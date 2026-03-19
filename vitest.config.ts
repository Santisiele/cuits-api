import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@helpers": path.resolve(__dirname, "./src/helpers"),
      "@sources": path.resolve(__dirname, "./src/sources"),
      "@routes": path.resolve(__dirname, "./src/routes"),
      "@schemas": path.resolve(__dirname, "./src/schemas.ts"),
    },
  },
  test: {
    globals: true,
    coverage: {
      reporter: ["text", "html"],
    },
  },
})
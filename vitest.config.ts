import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@helpers": path.resolve(__dirname, "./src/helpers"),
      "@sources": path.resolve(__dirname, "./src/sources"),
      "@routes": path.resolve(__dirname, "./src/routes"),
      "@schemas": path.resolve(__dirname, "./src/schemas.ts"),
      "@config": path.resolve(__dirname, "./src/config.ts"),
      "@scrapers": path.resolve(__dirname, "./src/scrapers"),
    },
  },
  test: {
    globals: true,
    coverage: {
      reporter: ["text", "html"],
    },
  },
})
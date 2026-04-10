import { defineConfig } from "vitest/config"
import path from "path"

const src = (p: string) => path.resolve(__dirname, "./src", p)

export default defineConfig({
  resolve: {
    alias: {
      "@domain": src("domain"),
      "@ports": src("ports"),
      "@application": src("application"),
      "@infrastructure": src("infrastructure"),
      "@helpers": src("helpers"),
      "@routes": src("routes"),
      "@scrapers": src("scrapers"),
      "@scripts": src("scripts"),
      "@config.js": src("config.ts"),
      "@config": src("config.ts"),
      "@schemas.js": src("schemas.ts"),
      "@schemas": src("schemas.ts"),
      "@logger.js": src("logger.ts"),
      "@logger": src("logger.ts"),
    },
  },
  test: {
    globals: true,
    typecheck: { tsconfig: "./tsconfig.test.json" },
    coverage: {
      reporter: ["text", "html"],
    },
  },
})
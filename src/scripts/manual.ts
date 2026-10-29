import "dotenv/config"
import { spawn } from "child_process"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jManualRunRepository } from "@infrastructure/neo4j/Neo4jManualRunRepository.js"
import { ManualRunService } from "@application/ManualRunService.js"

const [script, ...args] = process.argv.slice(2)
const name = process.env["npm_lifecycle_event"] ?? script ?? "unknown"

if (!script) {
  logger.error("Usage: tsx src/scripts/manual.ts <script.ts> [args...]")
  process.exit(1)
}

function runScript(target: string, scriptArgs: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, target, ...scriptArgs], { stdio: "inherit" })
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    child.on("error", () => resolve(1))
  })
}

const service = new ManualRunService(new Neo4jManualRunRepository(), runScript, (message) => logger.warn(message))
const exitCode = await service.run(name, script, args)
await Neo4jDriver.close()
process.exit(exitCode)

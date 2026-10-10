import { Effect } from "effect"

/** The extension's background program. For now it only says it started. */
const program = Effect.logInfo("service_worker_started")

Effect.runFork(program)

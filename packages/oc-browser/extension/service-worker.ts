import { Effect } from "effect"

/** The extension's program, which for now only logs that it started. */
const program = Effect.logInfo("service_worker_started")

Effect.runFork(program)

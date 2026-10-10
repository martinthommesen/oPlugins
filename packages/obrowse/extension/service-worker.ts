import { Effect } from "effect"

/** The extension's background program. For now it only says it started. */
const program = Effect.log("oBrowse service worker started")

Effect.runFork(program)

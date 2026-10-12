/**
 * The layout check: every plugin and library is named, shaped, and wired as
 * the ADRs and `AGENTS.md` say, and every plugin's fingerprint of the
 * libraries bundled into it is current. It prints one line per problem,
 * naming the file, and fails when it finds any. `pnpm run check:layout`
 * runs it.
 */
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import layoutCheck from "./layout-check.ts"

/*
 * The check prints every failure itself, so the runtime only sets the exit
 * status.
 */
NodeRuntime.runMain(
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((services) =>
      layoutCheck
        .main(new URL("..", import.meta.url).href)
        .pipe(Effect.provideContext(services)),
    ),
    Effect.scoped,
  ),
  { disableErrorReporting: true },
)

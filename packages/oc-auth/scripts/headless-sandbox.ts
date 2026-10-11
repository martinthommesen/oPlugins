import { Effect, FileSystem, Path, Struct, pipe } from "effect"
import hostSandbox from "@oc-lib/host-test/sandbox.ts"

type HostLayout = Effect.Success<ReturnType<typeof hostSandbox.layout>>

const EXECUTABLE = 0o755,
  SANDBOX_PREFIX = "oc-auth-",
  /* The host test's sandbox paths, and oc-auth's own beside them. */
  extend = Effect.fn("Headless.layout")(function* extend(layout: HostLayout) {
    const path = yield* Path.Path

    return Struct.assign(layout, {
      bin: path.join(layout.root, "bin"),
      models: path.join(layout.root, "models.json"),
      /** The plugin wrapper's package directory, which the host config names. */
      plugin: path.join(layout.install, "claude-auth-wrapper"),
      security: path.join(layout.root, "bin", "security"),
      smoke: path.join(layout.work, "smoke.txt"),
    })
  }),
  /*
   * A fresh furnished sandbox with `securityStub` as its `security`
   * stand-in, removed when the enclosing scope closes.
   */
  open = Effect.fn("Headless.acquireSandbox")(function* open(
    keep: boolean,
    securityStub: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      layout = yield* hostSandbox.acquire(SANDBOX_PREFIX, keep).pipe(
        Effect.tap((made) => hostSandbox.furnish(made)),
        Effect.flatMap((made) => extend(made)),
      )

    yield* pipe(
      [layout.bin, layout.plugin],
      Effect.forEach((directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      ),
    )
    yield* fs.writeFileString(layout.security, securityStub)
    yield* fs.chmod(layout.security, EXECUTABLE)

    return layout
  })

/** The smoke test's scoped sandbox. */
export default Object.freeze({ acquire: open })

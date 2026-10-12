import { Effect, Option, Path } from "effect"

import Environment from "./environment.ts"

/**
 * OpenCode's data directory: `$XDG_DATA_HOME/opencode` when that variable is
 * an absolute path, else `~/.local/share/opencode`.
 */
const opencodeDataDir = Effect.gen(function* resolveDataDir() {
  const environment = yield* Environment,
    path = yield* Path.Path,
    { home, xdgDataHome } = environment.variables

  return Option.match(xdgDataHome.pipe(Option.filter(path.isAbsolute)), {
    onNone: () => path.join(home, ".local", "share", "opencode"),
    onSome: (xdg) => path.join(xdg, "opencode"),
  })
})

export default opencodeDataDir

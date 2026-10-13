import { Data, Match, String as Str } from "effect"

/** What a `/show-usage` invocation asks for. */
type Request =
  | { readonly _tag: "Invalid"; readonly input: string }
  | { readonly _tag: "Set"; readonly shown: boolean }
  | { readonly _tag: "Toggle" }

const SidebarRequest = Data.taggedEnum<Request>(),
  /*
   * Parses the text after `/show-usage`: `on` or `off`, in any case, or
   * nothing, which toggles the section, as the command palette does.
   */
  parse = (input: string): Request => {
    const argument = Str.trim(input)

    return Match.value(Str.toLowerCase(argument)).pipe(
      Match.when("", () => SidebarRequest.Toggle()),
      Match.when("on", () => SidebarRequest.Set({ shown: true })),
      Match.when("off", () => SidebarRequest.Set({ shown: false })),
      Match.orElse(() => SidebarRequest.Invalid({ input: argument })),
    )
  }

/** The `/show-usage` command's argument. */
export default Object.freeze({ SidebarRequest, parse })

# Incognito in spanning mode

The agent may use incognito tabs, with grants kept apart from normal ones,
so the extension declares `incognito: "spanning"`. In split mode Chrome
would run a second copy of the extension with its own native host, and
under "the last browser to connect wins" opening an incognito window would
disconnect the user's normal profile, and the other way round. One
instance serving both kinds of tab keeps a single connection.

## Consequences

- Incognito tabs are marked as such, and their grants live in memory only,
  dropped when the last incognito window closes.
- The agent opens an incognito tab only when a tool call asks for one, and
  only if the user has allowed oc-browser in incognito in Chrome's settings.

# Site grants are enforced by the server and prompted in the browser

Every browser operation on a site needs a site grant, navigation included,
so that a page cannot simply steer the agent to carry data away in a URL.
The server plugin stores grants and checks them before forwarding any
command, which puts enforcement in one place that neither pages nor the
extension can override. The prompt that creates a grant appears in Chrome,
because OpenCode does not let server plugins open its own
allow-once/always/deny prompt.

## Considered options

- **Grants in extension storage**, as Claude in Chrome keeps them.
  Rejected: enforcement would sit in the extension, the component closest
  to hostile pages, and researchers showed other processes write approvals
  into that storage. Server storage is no defence against code running as
  the user either, which can reach OpenCode's storage and credentials too.
- **Prompt in the OpenCode TUI** through a TUI plugin. Rejected: it reaches
  only users running the TUI, not the desktop app, the web UI, or
  `opencode run`.
- **Gate acting only, and let navigation and reading through.** Rejected:
  navigation alone can carry off whatever the page put in the URL.

## Consequences

- Grants reduce exfiltration without preventing it. JavaScript on a granted
  site can still reach other sites, so JavaScript is confirmed per run
  outside trusted mode, and holding the relay to grants is an open security
  investigation.
- The user may be in the terminal when a prompt appears, so prompts raise a
  system notification and fail after 2 minutes unanswered.

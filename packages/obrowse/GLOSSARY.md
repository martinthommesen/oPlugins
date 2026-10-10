# oBrowse

oBrowse lets an OpenCode agent work in the user's own signed-in Chrome
profile, within limits the user sets.

## Language

### Browsers and connections

**Browser**:
The user's Chrome profile running the oBrowse extension, serving one
OpenCode server at a time.
_Avoid_: client, desktop

**Native host**:
The program on the browsing machine that links the browser to an OpenCode
server.
_Avoid_: bridge, daemon, helper

**Location**:
OpenCode's scope for one project directory and workspace.
_Avoid_: project, workspace

**Attachment**:
The live link between the browser and one location.
_Avoid_: connection, session

**Pairing**:
Linking a native host to a remote OpenCode server with a one-time code.
_Avoid_: login, registration

### Tabs

**Root session**:
The top session of an OpenCode session tree; its subagent sessions share
its tabs and grants.
_Avoid_: parent session, main session

**Agent tab group**:
The Chrome tab group belonging to one root session: the only tabs its
agent may use.
_Avoid_: agent tabs, workspace, window

### Permission

**Site**:
A registrable domain, such as `github.com`: the unit a grant covers.
_Avoid_: origin, host, domain

**Site grant**:
The user's answer about one site: once (for the session), always, or deny.
_Avoid_: permission, approval, allowlist entry

**Prompt**:
A question oBrowse puts to the user in Chrome: a site prompt, a JavaScript
confirmation, or a handoff.
_Avoid_: dialog, popup, permission request

**Handoff**:
A prompt in which the agent passes one step, such as entering a password,
to the user and waits for it to be done.
_Avoid_: takeover, pause

**Sensitive field**:
A password, one-time-code, or payment card field, or a control that
submits a payment.
_Avoid_: secret field, credential input

**Trusted mode**:
The setting under which a site grant also covers sensitive fields and
JavaScript.
_Avoid_: power mode, unsafe mode

### Remote access

**Relay**:
Raw DevTools access from the server plugin to an agent tab.
_Avoid_: CDP bridge, tunnel

**Tunnel**:
The route by which agent pages reach a remote server's local network.
_Avoid_: proxy, relay

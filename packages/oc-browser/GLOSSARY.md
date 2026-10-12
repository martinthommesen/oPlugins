# oc-browser

oc-browser lets an OpenCode agent work in the user's own signed-in Chrome
profile, within limits the user sets.

## Language

### Browsers and connections

**Browser**:
The user's Chrome profile running the oc-browser extension. It serves one
OpenCode server at a time.
_Avoid_: client, desktop

**Browsing machine**:
The computer the browser runs on.
_Avoid_: client machine, the machine Chrome runs on

**Native host**:
The program on the browsing machine that links the browser to an OpenCode
server.
_Avoid_: host (alone), bridge, daemon, helper

**Local server**:
An OpenCode server that runs on the browsing machine.
_Avoid_: local host

**Remote server**:
An OpenCode server that runs on a machine other than the browsing machine.
_Avoid_: the remote, remote host

**Location**:
OpenCode's scope for one project directory and workspace.
_Avoid_: project, workspace

**Attachment**:
The live link between the browser and one location. Attaching Chrome's
debugger to a tab is a different thing.
_Avoid_: connection, session

**Pairing**:
Linking a native host to a remote server with a one-time link.
_Avoid_: login, registration

### Tabs

**Agent tab group**:
The Chrome tab group of one root session, holding the only tabs that
session's agents may use.
_Avoid_: workspace, window

**Agent tab**:
A tab in an agent tab group.
_Avoid_: agent page

### Permission

**Site**:
A registrable domain, such as `github.com`: the unit a site grant covers.
_Avoid_: origin, host, domain

**Site grant**:
The user's answer about one site: once (for the session), always, or deny.
_Avoid_: permission, approval, allowlist entry

**Prompt**:
A question oc-browser puts to the user in Chrome: a site prompt, a
JavaScript confirmation, or a handoff.
_Avoid_: dialog, popup, permission request

**Handoff**:
A prompt in which the agent passes one step, such as entering a password,
to the user and waits for the user to finish it.
_Avoid_: takeover, pause

**Sensitive field**:
A password, one-time-code, or payment card field, or a control that
submits a payment.
_Avoid_: secret field, credential input

**Trusted mode**:
The plugin option under which a site grant also covers sensitive fields and
JavaScript runs.
_Avoid_: power mode, unsafe mode

### Remote access

**Relay**:
Raw DevTools access from the server plugin to an agent tab.
_Avoid_: CDP bridge, tunnel

**Tunnel**:
The route by which pages in agent tabs reach a remote server's local
network.
_Avoid_: proxy, relay

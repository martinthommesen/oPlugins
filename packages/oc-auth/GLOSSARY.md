# oc-auth

oc-auth lets OpenCode send Anthropic model requests with the Claude Code
subscription credentials on the user's machine.

## Language

### Accounts and credentials

**Claude Code account**:
A Claude subscription sign-in that Claude Code keeps on this machine.
_Avoid_: login, profile, user

**Credential store**:
Where Claude Code keeps one account's credentials: a Keychain item or its
credentials file. The `source` field names a store.
_Avoid_: source (for the place), backend, item

**Anthropic connection**:
The credential OpenCode holds for Anthropic, which `/connect` creates.
_Avoid_: auth, login, provider credential

**Import**:
Making a Claude Code account the Anthropic connection through `/connect`.
_Avoid_: adopt, add, link

**Active credential**:
The credential oc-auth sends model requests with now.
_Avoid_: current credential, selected account

### Keeping credentials current

**Refresh**:
Trading a refresh token at Anthropic's token endpoint for new tokens.
_Avoid_: renewal, token exchange (for the whole operation)

**Rotation**:
New tokens a program wrote to a credential store after it refreshed them.
_Avoid_: update

**Adoption**:
Taking up credentials rotated in their store outside OpenCode, in place of
OpenCode's copy.
_Avoid_: import, sync, reload

**Write-back**:
Saving refreshed tokens into the credential store they came from, so Claude
Code stays signed in.
_Avoid_: persist, sync

**Credential generation**:
The credentials a store holds between two rotations.
_Avoid_: version, token hash, credential key

**Transient failure**:
A refresh failure that says nothing against the refresh token, such as a
network error or a rate limit.
_Avoid_: soft failure, retryable error

**Terminal failure**:
A refresh that failed because the refresh token is no longer valid, so the
user must sign in to Claude Code again.
_Avoid_: hard failure, fatal error

**Cooldown**:
The wait after transient failures before oc-auth refreshes a store again.
_Avoid_: backoff (for the wait), retry delay

**Refresh lock**:
The lock that lets one OpenCode process at a time refresh a credential
store.
_Avoid_: mutex, single flight

### Requests

**Billing header**:
The system prompt line that marks a request as Claude Code subscription
traffic.
_Avoid_: signature, signing

**Tool alias**:
The name a tool carries in requests to Anthropic in place of its OpenCode
name.
_Avoid_: wire name

**Unauthorized recovery**:
What oc-auth does after Anthropic answers a request with 401 Unauthorized:
it adopts or refreshes the credential and sends the request again.
_Avoid_: retry, replay (for the whole recovery)

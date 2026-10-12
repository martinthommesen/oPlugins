# oc-auto

oc-auto has a reviewer model judge each permission prompt before it reaches
the user, as Codex's Auto-review does.

## Language

### Review

**Auto-review**:
The reviewer's judgment of one permission prompt before the user sees it.
_Avoid_: vetting, evaluation, guardian check

**Reviewer**:
The model that judges permission prompts.
_Avoid_: guardian, judge

**Fallback model**:
The reviewer model oc-auto uses after the backend rejects the configured
one.
_Avoid_: backup model

**Planned action**:
A permission prompt and the tool call that raised it, as the reviewer reads
them.
_Avoid_: action (alone), request (alone)

**Assessment**:
The reviewer's answer about one planned action: its risk, whether the user
authorized it, and the outcome it calls for.
_Avoid_: verdict, response, decision

**Verdict**:
What oc-auto does with a permission prompt after review: allow, deny, ask,
or escalate.
_Avoid_: outcome, decision

### Evidence

**Trusted entry**:
A transcript entry the user wrote. Only trusted entries can authorize an
action, and oc-auto never leaves one out.
_Avoid_: fixed entry, user entry

**Delegating agent**:
The agent that started a subagent and wrote its user messages.
_Avoid_: delegator, parent agent

### Denials

**Turn**:
The part of the root session from its newest user message on.
_Avoid_: round, step

**Denial breaker**:
The count of denials in a turn that, past a limit, hands prompts to the
user.
_Avoid_: strikes, circuit breaker

**Escalation**:
A denial handed to the user, because the turn reached a denial limit.
_Avoid_: strike-out, breaker trip

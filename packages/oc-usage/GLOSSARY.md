# oc-usage

oc-usage shows how much of the user's Claude and ChatGPT subscription usage
limits is used.

## Language

**Subscription**:
A Claude or ChatGPT plan whose usage limits oc-usage shows. oc-usage reads
the Claude subscription through the Anthropic connection, and the ChatGPT
subscription's Codex limits through the OpenAI connection.
_Avoid_: account (for the plan), provider, quota

**Limit window**:
The span one usage limit counts over, such as 5 hours or a week, with the
share used and when it resets.
_Avoid_: bucket, quota period

**Measurement**:
What a subscription's service reported about its limit windows, and when
oc-usage asked.
_Avoid_: snapshot, sample

**Usage report**:
Every subscription's state at once: its measurement, why there is none, or
what to do to connect it. `/usage` and the usage section show it.
_Avoid_: stats, status

**Interval**:
The least time between requests for the same connection identity to one
subscription's service within a project. Changing identity triggers a new
measurement immediately; a younger measurement for that identity is reused.
_Avoid_: cooldown (oc-auth's term), poll rate, TTL

**Connection identity**:
What tells one connection's account apart from another's. A measurement
belongs to the identity it was taken for, and never shows for another.
_Avoid_: account key, cache key

**Usage section**:
The part of the CLI sidebar that shows the usage report.
_Avoid_: widget, panel

**Sidebar setting**:
Whether the sidebar shows the usage section. `/show-usage` sets it, and it
lasts across restarts for every project and CLI.
_Avoid_: toggle, preference (oc-advisor's term)

# oc-advisor

oc-advisor lets an agent ask a second model, the advisor, for a second opinion
on its work.

## Language

**Advisor**:
The model an agent consults for a second opinion.
_Avoid_: consultant, reviewer, helper model

**Consultation**:
One request from an agent to the advisor, which ends in advice or in the
reason there is none.
_Avoid_: advisor call, query

**Consulting session**:
The session whose agent asks for a consultation.
_Avoid_: caller, parent session

**Consultation session**:
The short-lived session in which the advisor answers one consultation.
_Avoid_: child session, advisor session, temporary session

**Advice**:
The advisor's answer to a consultation.
_Avoid_: reply, response, guidance

**Availability**:
Whether a session may consult the advisor now, and the reason when it may
not.
_Avoid_: enabled, status

**Preference**:
A value the user sets with `/advisor`, which overrides the matching option
and lasts across restarts.
_Avoid_: choice, setting, stored option

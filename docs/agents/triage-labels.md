# Triage labels

Map the five canonical triage roles to local ticket status values.

| Canonical role    | Local status      | Meaning                                        |
| ----------------- | ----------------- | ---------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue         |
| `needs-info`      | `needs-info`      | Waiting on the reporter for more information   |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an autonomous agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation                  |
| `wontfix`         | `wontfix`         | Will not be actioned                           |

When a skill asks to apply a triage label, update the ticket's `Status:` line
with the corresponding local status. Preserve existing field styling, including
`**Status:**`.

Edit the Local status column to change the vocabulary later.

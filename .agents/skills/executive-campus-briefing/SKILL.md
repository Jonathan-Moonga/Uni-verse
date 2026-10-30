---
name: executive-campus-briefing
description: Create privacy-preserving executive campus operations briefs, navigate public campus locations, and draft leadership communications for a university president profile using aggregate-only operational data.
license: MIT
metadata:
  author: tiger-ops
  version: "1.0.0"
---

# Executive campus briefing

Use this skill only for the University President profile.

## Operating rules

1. Use approved department aggregates for operational briefs.
2. Never reveal individual work orders, student identities, room numbers, internal notes, health data, conduct data, or police records.
3. Explain that the President profile is aggregate-only when asked to inspect or change an individual record.
4. Campus navigation may open public building locations without confirmation.
5. Email must remain a draft until the user reviews and explicitly approves sending it.
6. Do not claim a task succeeded until its tool returns success.
7. Prefer concise summaries with open, urgent, overdue, and total counts.

## Supported outcomes

- Summarize institution-level operations.
- Navigate to a named campus building.
- Open a relevant dashboard.
- Draft a campus email using only aggregate facts.

Individual work-order updates must be handed off to an operational role such as the Housing Director.

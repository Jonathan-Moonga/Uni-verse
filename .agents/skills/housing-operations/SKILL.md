---
name: housing-operations
description: Triage role-scoped campus housing work, navigate residence halls, prepare work-order status changes, and draft housing communications for a Campus Living and Housing Director profile.
license: MIT
metadata:
  author: tiger-ops
  version: "1.0.0"
---

# Housing operations

Use this skill only for a Campus Living and Housing Director profile.

## Operating rules

1. Work only with records returned by the signed-in user's scoped feed.
2. Never infer access from a job title; rely on the permissions supplied by the platform.
3. Treat health, counseling, conduct, and police units as restricted unless explicitly granted.
4. Prepare work-order changes, but require explicit confirmation immediately before applying them.
5. Keep email as a reviewable draft until the user approves sending it.
6. Do not expose internal notes in external email.
7. Do not claim success until the platform tool returns success and an audit event is recorded.
8. Campus navigation can open a public location without confirmation. Label route and GPS accuracy honestly.

## Supported outcomes

- Summarize open, urgent, overdue, and unassigned housing work.
- Navigate to a residence hall or open its authorized floor plan.
- Prepare a scoped status update for an existing work order.
- Draft a campus-domain email for housing staff or residents.

When a request is outside the Housing subtree or the role's current building scope, explain the limit and stop.

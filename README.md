# Tiger Ops

Tiger Ops is a role-aware campus operations agent and interactive campus digital twin, modeled for Grambling State University. It combines scoped work orders, housing operations, floor plans, voice interaction, GPS-assisted wayfinding, and auditable agent actions in one web app.

## Why it fits Hacktoberfest Hack Day Grambling

- **Open-weight AI is central:** the copilot reasons with a local Ollama model (`qwen3:4b` by default), receives only the signed-in role's scoped data, and proposes tool actions.
- **Agent Skills Open Standard:** the President and Housing Director workflows live in `.agents/skills/*/SKILL.md` with standard YAML frontmatter and are loaded into the model's system context at runtime.
- **Open source:** the project is released under the MIT License.
- **Demo resilience:** if Ollama is unavailable, a deterministic command router preserves the navigation and approval demo while the UI clearly labels fallback mode.

## What the agent can do

- Talk back using the browser's speech synthesis and accept voice commands where Web Speech Recognition is supported.
- Navigate to a named building, for example: **“Show me Bowen.”**
- Use browser GPS as an optional, browser-local route origin. Coordinates are not sent to the server.
- Brief approved operational data for the signed-in role.
- Prepare a scoped work-order status change for a Housing Director, then wait for explicit approval.
- Draft and send campus-domain email into the auditable demo outbox, again only after approval.

The University President receives aggregate-only operations data. The Housing Director can act only inside the Housing subtree. Database row-level security remains the final enforcement layer even if a model proposes an invalid action.

## Run locally

Requirements: Node.js 20+ and, for open-weight reasoning, [Ollama](https://ollama.com/).

```bash
npm install
ollama pull qwen3:4b
npm run dev
```

Open `http://127.0.0.1:4173`. The sign-in screen lists demo accounts. Recommended demos:

- `president@gram.edu` — aggregate brief, navigation, and executive email drafting.
- `housing.director@gram.edu` — scoped housing brief, navigation, email, and confirmed work-order resolution.

The app prints each demo password on the sign-in card. Email is delivered to `/?mailbox` in development; it does not contact a real mail provider.

Configuration uses environment variables documented in `.env.example`:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
OLLAMA_TIMEOUT_MS=7000
```

## Demo script

1. Sign in as Housing Director and open **Ask Tiger**.
2. Say or type **“Show me Bowen.”** Tiger opens the 3D campus view and starts a route.
3. Select **Use my GPS** to set a private browser-local starting point, or keep the campus entrance fallback.
4. Ask **“Give me an operations summary.”**
5. Ask **“Resolve WO-1048.”** The agent prepares the status change; approve it and show the audit history.
6. Ask **“Email president@gram.edu a housing update.”** Review and approve the generated draft, then open the development mailbox.
7. Sign in as President and ask to resolve an individual issue. Tiger explains the aggregate-only boundary instead of leaking or changing the record.

## Architecture and safety

```text
Voice / text request
        ↓
Local open-weight model + role-specific SKILL.md
        ↓
Server validates proposed tool and role-scoped record
        ↓
User approves mutation
        ↓
Existing API → PostgreSQL RLS → database audit trigger
```

- The model never writes directly to the database.
- Navigation is immediate; email and record mutations require review and approval.
- Model output is allow-listed and schema-validated on the server.
- Work-order queries execute as the authenticated user under row-level security.
- Sensitive departments do not inherit into broad organizational scopes.
- GPS remains in browser memory and is never included in the agent request.
- The map is a prototype digital twin based on official campus-map geometry; walking time and route geometry are labeled estimates, not turn-by-turn emergency navigation.

## Existing technologies used

- Ollama and Qwen 3 for local open-weight reasoning.
- Agent Skills Open Standard for portable role workflows.
- Browser Web Speech APIs for voice input/output.
- Browser Geolocation API for optional on-campus positioning.
- PGlite/PostgreSQL-compatible row-level security, functions, and audit triggers.
- SVG/CSS for a lightweight 2D/3D campus digital twin with no proprietary map SDK.

## Verify

```bash
npm test
npm run build
```

For a competition submission, publish this repository publicly on GitHub, retain the MIT license, and include the repo link, demo link or short video, project description, and technologies used.

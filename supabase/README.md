# Tiger Ops database

`migrations/` is the source of truth for the schema and every access rule. Locally it runs on PGlite (Postgres in WebAssembly) through `npm run dev`; the same files deploy to Supabase unchanged.

| Path | Purpose | Goes to Supabase? |
| --- | --- | --- |
| `migrations/*_tiger_ops_core.sql` | Tables, row-level security, policy helpers, RPCs, auth triggers | Yes |
| `seed.sql` | Org chart, buildings, roles, sign-up domains (generated from `data.js` via `npm run db:seed-sql`) | Yes |
| `local/auth_shim.sql` | Stand-ins for Supabase's `auth.users`, `auth.uid()`, API roles, plus local sessions and the dev outbox | **No** |

## How access works

- Every table has RLS. The `app.*` functions mirror `permissions.js`, and `tests/database.test.js` checks that both agree for every role × work order.
- Sign-up goes through `app.handle_new_user()` on `auth.users`: an invitation token creates a scoped profile; otherwise only `allowed_email_domains` with a `default_role` (students on `gsumail.gram.edu`) may self-register, starting as `pending_verification` until the email is confirmed.
- Invitations are created with `public.create_invitation(...)`, which checks the inviter's `can_invite` roles, department and hall scope, feature subset, and maximum access length. Only a SHA-256 hash of the token is stored.
- Expired access stops working immediately (`app.actor()` ignores it); `public.expire_lapsed_access()` updates the stored status.

## Migrating to Supabase

1. `supabase link --project-ref <ref>` then `supabase db push` (applies `migrations/`), then run `seed.sql` in the SQL editor or with `supabase db reset` on a branch.
2. **Auth settings:** enable email confirmations. Leave public sign-up on; the trigger rejects anything that isn't an invitation or a student domain.
3. **Accepting invites:** the client calls `supabase.auth.signUp({ email, password, options: { data: { invitation_token, full_name } } })`. The trigger validates the token and email.
4. **Student sign-up:** `signUp` with `options.data = { full_name, home_building_id, home_room }`. Supabase sends the confirmation email; `app.handle_user_updated()` activates the profile when it's confirmed.
5. **Invitation emails:** call `create_invitation` (RPC), then send the returned link from an Edge Function through your email provider. The local server does the equivalent in `server/app.mjs` (`deliverInvitation`).
6. **Expiry sweep:** `select cron.schedule('expire-access', '*/10 * * * *', 'select public.expire_lapsed_access()');` with pg_cron enabled.
7. **Users:** local demo accounts use scrypt hashes in the shim and do not migrate. Invite real staff through the app after the first administrator is created (insert that one profile with the service role).

`server/app.mjs` reads data with `set local role authenticated` plus `request.jwt.claims`, which is exactly what Supabase's REST layer does, so the queries port directly to `supabase.rpc(...)` and `supabase.from(...)` calls.

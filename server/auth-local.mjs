// Local stand-in for Supabase Auth, backed by the auth shim tables on PGlite.
// Same interface as auth-supabase.mjs.
import { DUMMY_HASH, hashPassword, hashToken, newToken, verifyPassword } from "./auth.mjs";

export function createLocalAuth({ db, mailer, publicUrl }) {
  async function issueEmailToken(tx, userId, purpose, hours) {
    const token = newToken();
    await tx.query(
      "insert into local.email_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))",
      [hashToken(token), userId, purpose, hours]
    );
    return token;
  }

  async function consumeEmailToken(tx, token, purpose) {
    const { rows } = await tx.query(
      `update local.email_tokens set used_at = now()
       where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
       returning user_id`,
      [hashToken(String(token || "")), purpose]
    );
    return rows[0]?.user_id ?? null;
  }

  return {
    kind: "local",

    // Returns { userId } on success, null for wrong credentials.
    async signIn(email, password) {
      const { rows } = await db.asService((tx) => tx.query("select id, encrypted_password from auth.users where email = $1", [email]));
      const valid = await verifyPassword(password, rows[0]?.encrypted_password ?? DUMMY_HASH);
      if (!rows[0] || !valid) return null;
      await db.asService((tx) => tx.query("update auth.users set last_sign_in_at = now() where id = $1", [rows[0].id]));
      return { userId: rows[0].id };
    },

    async signUpStudent({ email, password, metadata }) {
      const passwordHash = await hashPassword(password);
      await db.asService(async (tx) => {
        const existing = await tx.query("select id from auth.users where email = $1", [email]);
        if (existing.rows.length) {
          // Same response either way, so sign-up can't be used to probe for accounts.
          await mailer.send(tx, { to: email, subject: "You already have a Tiger Ops account", body: "Someone tried to create an account with this email. If it was you, sign in or reset your password.", link: `${publicUrl}/?reset=request` });
          return;
        }
        const { rows } = await tx.query(
          "insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, $2, $3) returning id",
          [email, passwordHash, JSON.stringify(metadata)]
        );
        const token = await issueEmailToken(tx, rows[0].id, "verify_email", 24);
        await mailer.send(tx, { to: email, subject: "Verify your Tiger Ops student account", body: `Hi ${metadata.full_name}, confirm your GSU student email to finish creating your account. The link works for 24 hours.`, link: `${publicUrl}/?verify=${token}` });
      });
    },

    async resendVerification(email) {
      await db.asService(async (tx) => {
        const { rows } = await tx.query("select id from auth.users where email = $1 and email_confirmed_at is null", [email]);
        if (!rows.length) return;
        const token = await issueEmailToken(tx, rows[0].id, "verify_email", 24);
        await mailer.send(tx, { to: email, subject: "Verify your Tiger Ops student account", body: "Here's a new verification link. It works for 24 hours.", link: `${publicUrl}/?verify=${token}` });
      });
    },

    // Returns the confirmed email, or null if the link is invalid or used.
    async verifyEmail(token) {
      return db.asService(async (tx) => {
        const userId = await consumeEmailToken(tx, token, "verify_email");
        if (!userId) return null;
        const { rows } = await tx.query("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1 returning email", [userId]);
        return rows[0].email;
      });
    },

    async requestPasswordReset(email) {
      await db.asService(async (tx) => {
        const { rows } = await tx.query("select id from auth.users where email = $1", [email]);
        if (!rows.length) return;
        const token = await issueEmailToken(tx, rows[0].id, "reset_password", 24);
        await mailer.send(tx, { to: email, subject: "Reset your Tiger Ops password", body: "Use this link within 24 hours to choose a new password. If you didn't ask for this, ignore this email.", link: `${publicUrl}/?reset=${token}` });
      });
    },

    // Returns the user id whose password changed, or null if the link is invalid.
    async resetPassword(token, password) {
      const passwordHash = await hashPassword(password);
      return db.asService(async (tx) => {
        const userId = await consumeEmailToken(tx, token, "reset_password");
        if (!userId) return null;
        await tx.query("update auth.users set encrypted_password = $2, email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [userId, passwordHash]);
        return userId;
      });
    },

    // Creates a confirmed user; the sign-up trigger builds the profile from metadata.
    async adminCreateUser({ email, password, metadata }) {
      const passwordHash = await hashPassword(password);
      const { rows } = await db.asService((tx) => tx.query(
        "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3) returning id",
        [email, passwordHash, JSON.stringify(metadata)]
      ));
      return rows[0].id;
    },

    async checkPassword(email, password) {
      return Boolean(await this.signIn(email, password));
    },

    async setPassword(userId, password) {
      const passwordHash = await hashPassword(password);
      await db.asService((tx) => tx.query("update auth.users set encrypted_password = $2 where id = $1", [userId, passwordHash]));
    }
  };
}

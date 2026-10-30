// Supabase Auth (GoTrue) over its REST API. Same interface as auth-local.mjs.
// Supabase sends the confirmation and recovery emails itself, using the templates
// in supabase/templates, which link back to this app with a token hash.

class AuthError extends Error {}

// Legacy anon/service_role keys are JWTs and also go in Authorization; the newer
// sb_publishable_/sb_secret_ keys are sent only as `apikey`.
function headers(key, bearer) {
  const auth = bearer ?? (key.startsWith("eyJ") ? key : null);
  return { apikey: key, "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) };
}

function describe(data) {
  return String(data?.msg || data?.error_description || data?.message || data?.error || "");
}

// The sign-up trigger's RAISE surfaces from GoTrue as a generic database error.
function mapCreateError(status, data) {
  const message = describe(data);
  if (/database error/i.test(message)) return new AuthError("SIGNUP_REJECTED");
  if (data?.error_code === "weak_password" || /password/i.test(message)) return new AuthError(`WEAK_PASSWORD: ${message}`);
  if (data?.error_code === "email_exists" || /already (been )?registered/i.test(message)) return new AuthError("ALREADY_REGISTERED");
  return new AuthError(`Supabase Auth error ${status}: ${message}`);
}

export function createSupabaseAuth({ url, anonKey, serviceKey, redirectUrl, fetchImpl = fetch }) {
  const base = `${url.replace(/\/+$/, "")}/auth/v1`;
  const redirect = redirectUrl ? `?redirect_to=${encodeURIComponent(redirectUrl)}` : "";

  async function call(path, { method = "POST", key = anonKey, bearer, body } = {}) {
    const response = await fetchImpl(`${base}${path}`, { method, headers: headers(key, bearer), body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  return {
    kind: "supabase",

    async signIn(email, password) {
      const { ok, data } = await call("/token?grant_type=password", { body: { email, password } });
      if (ok) return { userId: data.user.id };
      if (data?.error_code === "email_not_confirmed" || /not confirmed/i.test(describe(data))) throw new AuthError("EMAIL_NOT_VERIFIED");
      return null;
    },

    async signUpStudent({ email, password, metadata }) {
      // With confirmations on, an existing email returns a look-alike success.
      const { ok, status, data } = await call(`/signup${redirect}`, { body: { email, password, data: metadata } });
      if (!ok) throw mapCreateError(status, data);
    },

    async resendVerification(email) {
      await call(`/resend${redirect}`, { body: { type: "signup", email } });
    },

    async verifyEmail(token) {
      const { ok, data } = await call("/verify", { body: { type: "signup", token_hash: String(token || "") } });
      return ok ? data.user?.email ?? null : null;
    },

    async requestPasswordReset(email) {
      await call(`/recover${redirect}`, { body: { email } });
    },

    async resetPassword(token, password) {
      if (String(token || "").startsWith("eyJ")) {
        const updated = await call("/user", { method: "PUT", bearer: token, body: { password } });
        if (!updated.ok) throw mapCreateError(updated.status, updated.data);
        return updated.data.id;
      }
      const verified = await call("/verify", { body: { type: "recovery", token_hash: String(token || "") } });
      if (!verified.ok) return null;
      const updated = await call("/user", { method: "PUT", bearer: verified.data.access_token, body: { password } });
      if (!updated.ok) throw mapCreateError(updated.status, updated.data);
      return verified.data.user.id;
    },

    async adminCreateUser({ email, password, metadata }) {
      const { ok, status, data } = await call("/admin/users", {
        key: serviceKey,
        body: { email, password, email_confirm: true, user_metadata: metadata }
      });
      if (!ok) throw mapCreateError(status, data);
      return data.id;
    },

    async checkPassword(email, password) {
      try {
        return Boolean(await this.signIn(email, password));
      } catch {
        return false;
      }
    },

    async setPassword(userId, password) {
      const { ok, status, data } = await call(`/admin/users/${encodeURIComponent(userId)}`, { method: "PUT", key: serviceKey, body: { password } });
      if (!ok) throw mapCreateError(status, data);
    },

    // Used by the readiness check.
    async settings() {
      return call("/settings", { method: "GET" });
    }
  };
}

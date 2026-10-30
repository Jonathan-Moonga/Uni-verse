import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuth } from "../server/auth-supabase.mjs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("Supabase auth sends signup and recovery redirects to the app", async () => {
  const requests = [];
  const auth = createSupabaseAuth({
    url: "https://project.supabase.co",
    anonKey: "sb_publishable_test",
    serviceKey: "sb_secret_test",
    redirectUrl: "https://tiger.example.edu",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({});
    }
  });

  await auth.signUpStudent({ email: "student@gsumail.gram.edu", password: "StrongPass10", metadata: { full_name: "Student" } });
  await auth.requestPasswordReset("student@gsumail.gram.edu");

  assert.match(requests[0].url, /\/signup\?redirect_to=https%3A%2F%2Ftiger\.example\.edu$/);
  assert.match(requests[1].url, /\/recover\?redirect_to=https%3A%2F%2Ftiger\.example\.edu$/);
  assert.equal(requests[0].options.headers.apikey, "sb_publishable_test");
});

test("Supabase recovery access tokens update the password without re-verification", async () => {
  let request;
  const auth = createSupabaseAuth({
    url: "https://project.supabase.co",
    anonKey: "sb_publishable_test",
    serviceKey: "sb_secret_test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ id: "11111111-1111-4111-8111-111111111111" });
    }
  });

  const userId = await auth.resetPassword("eyJ.recovery.token", "NewStrongPass10");

  assert.equal(userId, "11111111-1111-4111-8111-111111111111");
  assert.match(request.url, /\/auth\/v1\/user$/);
  assert.equal(request.options.headers.authorization, "Bearer eyJ.recovery.token");
  assert.deepEqual(JSON.parse(request.options.body), { password: "NewStrongPass10" });
});

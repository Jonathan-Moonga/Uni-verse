import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApp } from "../server/app.mjs";
import { openDatabase } from "../server/db.mjs";
import { demoAccounts, demoPassword } from "../server/demo.mjs";

let db;
let server;
let base;

before(async () => {
  db = await openDatabase();
  let handler;
  server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  handler = createApp({ db, publicUrl: base, devMode: true, logMail: false });
});

after(async () => {
  server.close();
  await db.close();
});

function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

async function lastMailLink(to) {
  const { rows } = await db.pg.query("select link from server_private.outbox where to_email = $1 order by id desc limit 1", [to]);
  return new URL(rows[0].link);
}

test("only the browser app is served, never server code or SQL", async () => {
  for (const path of ["/server/app.mjs", "/supabase/seed.sql", "/package.json", "/.data/x", "/node_modules/@electric-sql/pglite/package.json", "/supabase/local/auth_shim.sql"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(`${base}/permissions.js`)).status, 200);
});

test("health endpoint verifies the active database and auth adapters", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, database: "local", auth: "local" });
});

test("student signs up with a GSU student email, verifies, then signs in", async () => {
  const call = client();
  const bad = await call("POST", "/api/auth/signup", { email: "kid@gmail.com", password: "Password123", fullName: "Kid" });
  assert.equal(bad.status, 403);

  const ok = await call("POST", "/api/auth/signup", { email: "Jordan.Lee@gsumail.gram.edu", password: "Password123", fullName: "Jordan Lee", homeBuildingId: "holland", homeRoom: "112" });
  assert.equal(ok.status, 200);

  const early = await call("POST", "/api/auth/login", { email: "jordan.lee@gsumail.gram.edu", password: "Password123", portal: "student" });
  assert.equal(early.status, 403);
  assert.equal(early.body.code, "EMAIL_NOT_VERIFIED");

  const link = await lastMailLink("jordan.lee@gsumail.gram.edu");
  const verified = await call("POST", "/api/auth/verify", { token: link.searchParams.get("verify") });
  assert.equal(verified.status, 200);
  const reuse = await call("POST", "/api/auth/verify", { token: link.searchParams.get("verify") });
  assert.equal(reuse.status, 410);

  const login = await call("POST", "/api/auth/login", { email: "jordan.lee@gsumail.gram.edu", password: "Password123", portal: "student" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "student");
  assert.equal(login.body.user.buildingId, "holland");

  const created = await call("POST", "/api/work-orders", { title: "Shower drain clogged", description: "Water pools", category: "Plumbing", priority: "routine", buildingId: "holland", room: "112" });
  assert.equal(created.status, 200);
  assert.equal(created.body.orgId, "housing-maintenance");
  const elsewhere = await call("POST", "/api/work-orders", { title: "Not my hall", description: "x", category: "Plumbing", priority: "routine", buildingId: "mildred-jones" });
  assert.equal(elsewhere.status, 403);
});

test("every listed demo login signs in through its own portal as the listed role", async () => {
  for (const account of demoAccounts()) {
    const { status, body } = await client()("POST", "/api/auth/login", { email: account.email, password: account.password, portal: account.kind });
    assert.equal(status, 200, account.email);
    assert.equal(body.user.roleLabel, account.role, account.email);
  }
});

test("wrong passwords and wrong portals are rejected", async () => {
  const call = client();
  const wrong = await call("POST", "/api/auth/login", { email: "jreed@gram.edu", password: "nope-nope-1" });
  assert.equal(wrong.status, 401);
  const portal = await call("POST", "/api/auth/login", { email: "jreed@gram.edu", password: demoPassword("jreed@gram.edu"), portal: "student" });
  assert.equal(portal.status, 409);
  assert.equal(portal.body.portal, "staff");
  assert.equal((await call("GET", "/api/work-orders")).status, 401);
});

test("role agent proposes navigation and sends only approved campus email", async () => {
  const head = client();
  assert.equal((await head("POST", "/api/auth/login", { email: "housing.director@gram.edu", password: demoPassword("housing.director@gram.edu"), portal: "staff" })).status, 200);
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
  const chat = await head("POST", "/api/agent/chat", { message: "Show me Bowen" });
  if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = previous;
  assert.equal(chat.status, 200);
  assert.equal(chat.body.action.type, "navigate_building");
  assert.equal(chat.body.action.args.buildingId, "jde-bowen");

  const sent = await head("POST", "/api/agent/email", { to: "president@gram.edu", subject: "Housing update", body: "Scoped housing operations update." });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivery, "demo_outbox");
  const mail = await db.pg.query("select subject from server_private.outbox where to_email = 'president@gram.edu' order by id desc limit 1");
  assert.equal(mail.rows[0].subject, "Housing update");
  const audit = await db.pg.query("select action from public.audit_events where action = 'Sent agent email' order by id desc limit 1");
  assert.equal(audit.rows[0].action, "Sent agent email");

  const rejected = await head("POST", "/api/agent/email", { to: "outside@example.com", subject: "No", body: "No" });
  assert.equal(rejected.status, 400);
});

test("department head invites a time-limited contractor who accepts and signs in", async () => {
  const head = client();
  const login = await head("POST", "/api/auth/login", { email: "housing.director@gram.edu", password: demoPassword("housing.director@gram.edu"), portal: "staff" });
  assert.equal(login.status, 200);

  const tooLong = await head("POST", "/api/invitations", { email: "pipes@example.com", role: "contractor", orgId: "housing-maintenance", accessDays: 200 });
  assert.equal(tooLong.status, 400);

  const invite = await head("POST", "/api/invitations", {
    email: "pipes@example.com", role: "contractor", orgId: "housing-maintenance", accessDays: 30,
    permissions: ["dashboard:view:assigned", "work_order:view", "work_order:update"], fullName: "Pipes Plumbing"
  });
  assert.equal(invite.status, 200);
  const token = new URL(invite.body.link).searchParams.get("invite");

  const guest = client();
  const preview = await guest("GET", `/api/invitations/preview?token=${token}`);
  assert.equal(preview.body.roleLabel, "External Contractor");
  assert.equal(preview.body.accessDays, 30);
  assert.ok(!preview.body.features.includes("floorplan:view"));

  const accepted = await guest("POST", "/api/auth/accept-invite", { token, fullName: "Pat Pipes", password: "Contract0r!" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.user.role, "contractor");
  const days = (new Date(accepted.body.user.accessExpiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29 && days <= 30);

  const again = await client()("POST", "/api/auth/accept-invite", { token, fullName: "Pat", password: "Contract0r!" });
  assert.equal(again.status, 410);

  const people = await head("GET", "/api/people");
  const pat = people.body.people.find((person) => person.email === "pipes@example.com");
  assert.equal(pat.canManage, true);
  assert.equal((await head("PATCH", `/api/people/${pat.id}`, { action: "suspend" })).status, 200);
  assert.equal((await guest("GET", "/api/session")).body.user, null);
});

test("cross-origin writes are blocked", async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ email: "jreed@gram.edu", password: demoPassword("jreed@gram.edu") })
  });
  assert.equal(response.status, 403);
});

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { demoStaff, initialWorkOrders, personas } from "../data.js";
import { canAssignWorkOrder, canUpdateWorkOrder, canViewWorkOrder } from "../permissions.js";
import { openDatabase } from "../server/db.mjs";

let db;
const uid = new Map();
const woid = new Map();

before(async () => {
  db = await openDatabase();
  const people = await db.pg.query("select id, email from public.profiles");
  const byEmail = new Map(people.rows.map((row) => [row.email, row.id]));
  for (const person of [...personas, ...demoStaff]) uid.set(person.id, byEmail.get(person.email));
  const orders = await db.pg.query("select id, number from public.work_orders");
  for (const row of orders.rows) woid.set(`WO-${row.number}`, row.id);
});

after(async () => {
  await db.close();
});

const as = (personaId, sql, params = []) => db.asUser(uid.get(personaId), (tx) => tx.query(sql, params));

// Evaluates policy functions with a user's identity but as the owner, so the
// row is visible to the check itself.
const evaluateAs = (personaId, sql, params = []) => db.pg.transaction(async (tx) => {
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid.get(personaId) })]);
  return tx.query(sql, params);
});

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, new RegExp(code));
    return true;
  });
}

test("database policy matches permissions.js for every persona and work order", async () => {
  for (const persona of personas) {
    for (const order of initialWorkOrders) {
      const { rows } = await evaluateAs(persona.id,
        `select app.can_access_work_order(w, 'view') as view, app.can_access_work_order(w, 'update') as update,
                app.can_access_work_order(w, 'assign') as assign
         from public.work_orders w where w.id = $1`, [woid.get(order.id)]);
      const label = `${persona.id} × ${order.id}`;
      assert.equal(rows[0].view, canViewWorkOrder(persona, order), `${label} view`);
      assert.equal(rows[0].update, canUpdateWorkOrder(persona, order), `${label} update`);
      assert.equal(rows[0].assign, canAssignWorkOrder(persona, order), `${label} assign`);
    }
  }
});

test("row-level security filters direct table reads", async () => {
  const student = await as("u-student", "select number from public.work_orders");
  assert.deepEqual(student.rows.map((r) => r.number), [1048]);
  const president = await as("u-president", "select count(*)::int as n from public.work_orders");
  assert.equal(president.rows[0].n, 0);
});

test("students never see internal notes, but do see public progress updates", async () => {
  const notes = await as("u-student", "select visibility from public.work_order_notes");
  assert.deepEqual(notes.rows.map((r) => r.visibility), ["public"]);
  const feed = await as("u-student", "select latest_internal_note, public_note_count from public.work_order_feed()");
  assert.equal(feed.rows[0].latest_internal_note, null);
  assert.equal(feed.rows[0].public_note_count, 1);
});

test("clients cannot spoof routing, ownership, or lifecycle on insert", async () => {
  const { rows } = await as("u-student",
    `insert into public.work_orders (title, description, category, building_id, room)
     values ('Window will not latch', 'Latch is broken', 'General maintenance', 'mildred-jones', '203')
     returning org_id, status, requester_id`);
  assert.equal(rows[0].org_id, "housing-maintenance");
  assert.equal(rows[0].status, "triage");
  assert.equal(rows[0].requester_id, uid.get("u-student"));
  await rejects(as("u-student",
    `insert into public.work_orders (title, description, category, building_id) values ('Elsewhere', 'x', 'Plumbing', 'holland')`),
  "row-level security");
  await rejects(as("u-student", `insert into public.work_orders (title, description, category, building_id, org_id) values ('Spoof', 'x', 'Plumbing', 'mildred-jones', 'it-help-desk')`),
    "permission denied");
});

test("technicians can move status but not reassign or edit locked fields", async () => {
  const id = woid.get("WO-1048");
  await as("u-tech", "update public.work_orders set status = 'in_progress' where id = $1", [id]);
  await rejects(as("u-tech", "update public.work_orders set assignee_id = $2 where id = $1", [id, uid.get("u-tech-2")]), "ASSIGN_DENIED");
  await rejects(as("u-tech", "update public.work_orders set title = 'x' where id = $1", [id]), "permission denied");
});

test("assignment is limited to staff inside the assigner's scope", async () => {
  const id = woid.get("WO-1049");
  await rejects(as("u-dispatch", "update public.work_orders set assignee_id = $2 where id = $1", [id, uid.get("u-it-tech")]), "ASSIGNEE_OUT_OF_SCOPE");
  const { rows } = await as("u-dispatch", "update public.work_orders set assignee_id = $2 where id = $1 returning status", [id, uid.get("u-tech-3")]);
  assert.equal(rows[0].status, "assigned");
  const list = await as("u-dispatch", "select full_name from public.assignable_profiles()");
  assert.ok(list.rows.every((r) => !/Morgan|Network|Clinic/.test(r.full_name)));
});

test("every change lands in the audit log, scoped by department", async () => {
  const housing = await as("u-housing-director", "select action, target_label from public.audit_events where action = 'Updated work'");
  assert.ok(housing.rows.length >= 2);
  const it = await as("u-it", "select target_label from public.audit_events where target_label = 'WO-1049'");
  assert.equal(it.rows.length, 0);
});

test("invitations respect role, department, building, feature, and duration limits", async () => {
  const invite = (persona, args) => as(persona,
    "select * from public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [args.email, args.role, args.org, args.buildings ?? [], args.features ?? null, args.days ?? null, 72, args.name ?? null, null]);

  await rejects(invite("u-hall-director", { email: "ra2@gsumail.gram.edu", role: "residentAssistant", org: "residence-life", buildings: ["holland"] }), "BUILDING_OUT_OF_SCOPE");
  await rejects(invite("u-hall-director", { email: "x@gram.edu", role: "technician", org: "housing-maintenance" }), "ROLE_NOT_INVITABLE");
  await rejects(invite("u-it", { email: "y@gram.edu", role: "itTechnician", org: "housing-maintenance" }), "ORG_OUT_OF_SCOPE");
  await rejects(invite("u-housing-director", { email: "z@gram.edu", role: "technician", org: "housing-maintenance", features: ["work_order:assign"] }), "FEATURES_OUT_OF_ROLE");
  await rejects(invite("u-housing-director", { email: "c@example.com", role: "contractor", org: "housing-maintenance", days: 365 }), "ACCESS_TOO_LONG");
  await rejects(invite("u-tech", { email: "t@gram.edu", role: "technician", org: "housing-maintenance" }), "INVITE_NOT_PERMITTED");
  await rejects(invite("u-president", { email: "jreed@gram.edu", role: "staffRequester", org: "academic-affairs" }), "ALREADY_REGISTERED");

  const ok = await invite("u-hall-director", { email: "New.RA@gsumail.gram.edu", role: "residentAssistant", org: "residence-life", buildings: ["mildred-jones"], days: 120, name: "New RA" });
  assert.equal(ok.rows[0].token.length, 64);
  await rejects(invite("u-housing-director", { email: "new.ra@gsumail.gram.edu", role: "residentAssistant", org: "residence-life", buildings: ["mildred-jones"] }), "INVITE_PENDING");

  // Accepting creates a scoped, time-limited profile.
  const token = ok.rows[0].token;
  const preview = await db.asAnon((tx) => tx.query("select * from public.invitation_preview($1)", [token]));
  assert.equal(preview.rows[0].role_label, "Resident Assistant");
  await db.pg.query(
    "insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ('new.ra@gsumail.gram.edu', now(), $1)",
    [JSON.stringify({ invitation_token: token, full_name: "Jamie Ray" })]
  );
  const profile = await db.pg.query("select role_key, building_ids, scope_org_id, status, access_expires_at > now() + interval '119 days' as long_enough from public.profiles where email = 'new.ra@gsumail.gram.edu'");
  assert.deepEqual(profile.rows[0], { role_key: "residentAssistant", building_ids: ["mildred-jones"], scope_org_id: "campus-living-housing", status: "active", long_enough: true });

  // Tokens are single use.
  await rejects(db.pg.query("insert into auth.users (email, raw_user_meta_data) values ('new.ra@gsumail.gram.edu', $1)", [JSON.stringify({ invitation_token: token })]), "duplicate key|INVITATION_INVALID");
});

test("self sign-up is limited to student email domains and starts unverified", async () => {
  await rejects(db.pg.query("insert into auth.users (email) values ('someone@gmail.com')"), "SIGNUP_REQUIRES_INVITATION");
  await rejects(db.pg.query("insert into auth.users (email) values ('newstaff@gram.edu')"), "SIGNUP_REQUIRES_INVITATION");
  const { rows } = await db.pg.query(
    "insert into auth.users (email, raw_user_meta_data) values ('jsmith@gsumail.gram.edu', $1) returning id",
    [JSON.stringify({ full_name: "J Smith", home_building_id: "holland", home_room: "112" })]
  );
  const before = await db.pg.query("select status, role_key, home_building_id, home_room from public.profiles where id = $1", [rows[0].id]);
  assert.deepEqual(before.rows[0], { status: "pending_verification", role_key: "student", home_building_id: "holland", home_room: "112" });
  const blocked = await db.asUser(rows[0].id, (tx) => tx.query("select count(*)::int as n from public.work_order_feed()"));
  assert.equal(blocked.rows[0].n, 0);
  await db.pg.query("update auth.users set email_confirmed_at = now() where id = $1", [rows[0].id]);
  const afterVerify = await db.pg.query("select status from public.profiles where id = $1", [rows[0].id]);
  assert.equal(afterVerify.rows[0].status, "active");
});

test("managers can suspend and extend only roles they may invite", async () => {
  const contractor = await db.pg.query("select id from public.profiles where role_key = 'contractor'");
  const id = contractor.rows[0].id;
  await as("u-housing-director", "select public.manage_profile($1, 'extend', 30)", [id]);
  await rejects(as("u-housing-director", "select public.manage_profile($1, 'extend', 400)", [id]), "ACCESS_TOO_LONG");
  await rejects(as("u-it", "select public.manage_profile($1, 'suspend')", [id]), "PROFILE_NOT_MANAGEABLE");
  await rejects(as("u-housing-director", "select public.manage_profile($1, 'suspend')", [uid.get("u-vpsa")]), "PROFILE_NOT_MANAGEABLE");
  await as("u-housing-director", "select public.manage_profile($1, 'suspend')", [uid.get("u-tech")]);
  const feed = await as("u-tech", "select count(*)::int as n from public.work_order_feed()");
  assert.equal(feed.rows[0].n, 0);
  await as("u-housing-director", "select public.manage_profile($1, 'reactivate')", [uid.get("u-tech")]);
});

test("expired access stops working immediately", async () => {
  await db.pg.query("update public.profiles set access_expires_at = now() - interval '1 minute' where role_key = 'contractor'");
  const contractor = await db.pg.query("select id from public.profiles where role_key = 'contractor'");
  const me = await db.asUser(contractor.rows[0].id, (tx) => tx.query("select (app.actor()).id"));
  assert.equal(me.rows[0].id, null);
  const n = await db.pg.query("select public.expire_lapsed_access() as n");
  assert.ok(n.rows[0].n >= 1);
});

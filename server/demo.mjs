// Demo accounts and records. Every account is created through the same paths a
// real user takes: staff accept a system invitation, students self-register with
// a GSU student email. Nothing bypasses the sign-up trigger.
import { randomBytes } from "node:crypto";
import { demoStaff, initialAuditEvents, initialWorkOrders, personas, roleTemplates } from "../data.js";
import { hashToken } from "./auth.mjs";

// Supporting staff (extra technicians, requesters) share this password.
export const DEMO_PASSWORD = "TigerOps!2026";

// One login per access level, each with its own password. Demo only.
export const demoLogins = [
  { email: "president@gram.edu", password: "Pres!Tiger2026", kind: "staff" },
  { email: "coo@gram.edu", password: "Ops!Chief2026", kind: "staff" },
  { email: "vpsa@gram.edu", password: "VPSA!Tiger2026", kind: "staff" },
  { email: "housing.director@gram.edu", password: "Housing!Dir2026", kind: "staff" },
  { email: "tgreene@gram.edu", password: "HallDir!Jones26", kind: "staff" },
  { email: "dispatch@gram.edu", password: "Dispatch!2026", kind: "staff" },
  { email: "jreed@gram.edu", password: "Tech!Plumb2026", kind: "staff" },
  { email: "cdalton@gsumail.gram.edu", password: "RA!Jones2026", kind: "staff" },
  { email: "it.director@gram.edu", password: "IT!Director26", kind: "staff" },
  { email: "mhayes@gram.edu", password: "HelpDesk!2026", kind: "staff" },
  { email: "facilities.director@gram.edu", password: "Facilities!26", kind: "staff" },
  { email: "health.director@gram.edu", password: "Clinic!Dir2026", kind: "staff" },
  { email: "auditor@gram.edu", password: "Audit!Review26", kind: "staff" },
  { email: "faculty@gram.edu", password: "Faculty!2026", kind: "staff" },
  { email: "mcarter@gsumail.gram.edu", password: "Student!203Jones", kind: "student" },
  { email: "rivers.hvac@example.com", password: "Contractor!HVAC26", kind: "partner" }
];

export function demoPassword(email) {
  return demoLogins.find((login) => login.email === email)?.password ?? DEMO_PASSWORD;
}

const contractor = {
  id: "u-contractor",
  email: "rivers.hvac@example.com",
  name: "Rivers HVAC (contractor)",
  role: "contractor",
  orgId: "housing-maintenance",
  accessDays: 21,
  invitedBy: "u-housing-director"
};

// Everyone the demo needs, in an order where inviters exist before invitees.
export function demoPeople() {
  return [...personas, ...demoStaff, contractor];
}

export function isStudentAccount(person) {
  return roleTemplates[person.role].selfSignup === true;
}

// A system invitation (no inviter) for one demo person. Returns the raw token.
export async function createSystemInvitation(db, person) {
  const token = randomBytes(32).toString("hex");
  // A failed earlier run may have left one behind; only one pending invite per email is allowed.
  await db.query("update public.invitations set status = 'revoked' where email = $1 and status = 'pending'", [person.email]);
  await db.query(
    `insert into public.invitations (email, full_name, role_key, org_unit_id, building_ids, permissions, access_days, token_hash, expires_at, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 day', 'Created by Tiger Ops bootstrap')`,
    [person.email, person.name, person.role, person.orgId, person.buildingIds ?? [], roleTemplates[person.role].permissions,
      person.accessDays ?? null, hashToken(token)]
  );
  return token;
}

// Metadata the sign-up trigger reads, for either path.
export function signupMetadata(person, invitationToken) {
  return isStudentAccount(person)
    ? { full_name: person.name, home_building_id: person.buildingId ?? null, home_room: person.room ?? null }
    : { full_name: person.name, invitation_token: invitationToken };
}

// Creates any missing demo accounts through `auth.adminCreateUser`, then the demo
// records if the database has none. Safe to run repeatedly.
export async function seedDemo(db, auth) {
  const ids = new Map();
  for (const person of demoPeople()) {
    const existing = await db.query("select id from public.profiles where email = $1", [person.email]);
    if (existing.rows.length) {
      ids.set(person.id, existing.rows[0].id);
      continue;
    }
    const token = isStudentAccount(person) ? null : await createSystemInvitation(db, person);
    const userId = await auth.adminCreateUser({ email: person.email, password: demoPassword(person.email), metadata: signupMetadata(person, token) });
    ids.set(person.id, userId);
  }
  const { rows } = await db.query("select count(*)::int as n from public.work_orders");
  if (rows[0].n === 0) await seedDemoRecords(db, ids);
  return ids;
}

// Work orders, notes, and audit history. `ids` maps persona id → profile id.
export async function seedDemoRecords(db, ids) {
  if (ids.has(contractor.invitedBy)) {
    await db.query("update public.profiles set invited_by = $2 where email = $1", [contractor.email, ids.get(contractor.invitedBy)]);
  }

  const orderIds = new Map();
  for (const order of initialWorkOrders) {
    const { rows } = await db.query(
      `insert into public.work_orders (number, title, description, category, priority, status, org_id, building_id, room,
                                       requester_id, assignee_id, entry_allowed, source, due_at, created_at, updated_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [Number(order.id.replace(/\D/g, "")), order.title, order.description, order.category, order.priority, order.status,
        order.orgId, order.buildingId, order.room, ids.get(order.requesterId) ?? null, ids.get(order.assigneeId) ?? null,
        order.entryAllowed, order.source, order.dueAt, order.createdAt, order.updatedAt,
        order.status === "completed" ? order.updatedAt : null]
    );
    orderIds.set(order.id, rows[0].id);
    if (order.internalNote) {
      await db.query(
        `insert into public.work_order_notes (work_order_id, author_id, body, visibility, created_at) values ($1, $2, $3, 'internal', $4)`,
        [rows[0].id, ids.get(order.assigneeId) ?? ids.get(order.requesterId) ?? null, order.internalNote, order.updatedAt]
      );
    }
  }

  await db.query(
    `insert into public.work_order_notes (work_order_id, author_id, body, visibility, created_at)
     values ($1, $2, 'A plumber is scheduled for today after 2:30 PM. Please keep the area under the sink clear.', 'public', '2026-10-30T09:12:00-05:00')`,
    [orderIds.get("WO-1048"), ids.get("u-dispatch")]
  );
  await db.query("select setval('public.work_order_number_seq', (select max(number) from public.work_orders))");

  // Account creation and the inserts above were audited; replace that with the scripted history.
  await db.query("delete from public.audit_events");
  for (const event of [...initialAuditEvents].reverse()) {
    await db.query(
      `insert into public.audit_events (at, actor_label, action, target_type, target_id, target_label, detail, org_id)
       values ($1, $2, $3, 'work_order', $4, $5, $6, $7)`,
      [event.at, event.actor, event.action, orderIds.get(event.target) ?? null, event.target, event.detail, event.orgId]
    );
  }
}

export function demoAccounts() {
  const people = demoPeople();
  return demoLogins.map((login) => {
    const person = people.find((item) => item.email === login.email);
    return {
      email: login.email,
      password: login.password,
      name: person.name,
      role: roleTemplates[person.role].label,
      level: roleTemplates[person.role].level,
      kind: login.kind
    };
  });
}

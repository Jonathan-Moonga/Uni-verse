import { createReadStream, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { buildings, roleTemplates } from "../data.js";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  clearSessionCookie,
  createRateLimiter,
  hashToken,
  newToken,
  parseCookies,
  passwordProblem,
  sessionCookie
} from "./auth.mjs";
import { demoAccounts } from "./demo.mjs";
import { answerAgent, isCampusEmail } from "./agent.mjs";
import { createLocalAuth } from "./auth-local.mjs";
import { createMailer } from "./mailer.mjs";

const root = resolve(import.meta.dirname, "..");
// Only the browser app is served. Server code, SQL, and data never leave disk.
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/api.js", "api.js"],
  ["/data.js", "data.js"],
  ["/permissions.js", "permissions.js"],
  ["/floorplans.js", "floorplans.js"]
]);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const categories = ["Plumbing", "Electrical", "HVAC", "Custodial", "IT support", "General maintenance", "Inspection", "Safety"];
const priorities = ["routine", "urgent", "emergency"];
const statuses = ["triage", "assigned", "in_progress", "waiting_parts", "completed", "cancelled"];

// Database error codes raised by the migration → user-facing responses.
const knownErrors = {
  NOT_AUTHENTICATED: [401, "Please sign in again."],
  EMAIL_NOT_VERIFIED: [403, "Verify your email before signing in. Check your inbox for the link."],
  SIGNUP_REJECTED: [403, "This account cannot be created. Use an eligible student email or ask for an invitation."],
  WEAK_PASSWORD: [400, "Use at least 10 characters with letters and numbers."],
  INVITE_NOT_PERMITTED: [403, "Your role can't send invitations."],
  ROLE_NOT_INVITABLE: [403, "Your role can't invite people into that role."],
  ORG_OUT_OF_SCOPE: [403, "That department is outside your scope."],
  BUILDING_OUT_OF_SCOPE: [403, "You can only grant halls you supervise."],
  BUILDINGS_REQUIRED: [400, "Pick at least one hall for this role."],
  FEATURES_OUT_OF_ROLE: [403, "Those features aren't part of this role."],
  ACCESS_TOO_LONG: [400, "That access period is longer than this role allows."],
  INVITE_WINDOW_INVALID: [400, "Invitation links can stay valid for 1 hour to 14 days."],
  ALREADY_REGISTERED: [409, "Someone with that email already has an account."],
  INVITE_PENDING: [409, "There's already a pending invitation for that email. Resend it from the invitations list."],
  INVALID_EMAIL: [400, "Enter a valid email address."],
  UNKNOWN_ROLE: [400, "Unknown role."],
  UNKNOWN_BUILDING: [400, "Unknown building."],
  INVITE_NOT_FOUND: [404, "Invitation not found."],
  INVITE_NOT_PENDING: [409, "That invitation is no longer pending."],
  INVITATION_INVALID: [410, "This invitation link is invalid, already used, or expired. Ask whoever invited you to resend it."],
  INVITATION_EMAIL_MISMATCH: [400, "This invitation was sent to a different email address."],
  SIGNUP_REQUIRES_INVITATION: [403, "Only @gsumail.gram.edu student emails can self-register. Faculty and staff accounts are created by invitation from a department head."],
  ASSIGN_DENIED: [403, "You can't assign this work order."],
  ASSIGNEE_OUT_OF_SCOPE: [403, "That person is outside your department's scope."],
  UPDATE_DENIED: [403, "You can't change this work order's status."],
  WORK_ORDER_FIELDS_LOCKED: [403, "Only status, assignment, and priority can change after submission."],
  PROFILE_NOT_MANAGEABLE: [403, "You can't manage this person's access."],
  ACCESS_EXPIRED_EXTEND_FIRST: [409, "This access has expired. Extend it to reactivate."],
  UNKNOWN_ACTION: [400, "Unknown action."]
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function toHttpError(error) {
  if (error instanceof HttpError) return error;
  const message = String(error?.message || "");
  for (const [code, [status, text]] of Object.entries(knownErrors)) {
    if (message.includes(code)) return new HttpError(status, text, { code });
  }
  if (/row-level security|permission denied/i.test(message)) return new HttpError(403, "You don't have access to do that.");
  if (error?.code === "23514" || error?.code === "22P02" || error?.code === "23503") return new HttpError(400, "Some fields are invalid.");
  return null;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!/^application\/json/i.test(request.headers["content-type"] || "")) throw new HttpError(415, "Send JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

const text = (value, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const normalizeEmail = (value) => text(value, 254).toLowerCase();
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));

function portalFor(roleKey) {
  if (roleKey === "student") return "student";
  if (roleKey === "contractor") return "partner";
  return "staff";
}

function mapProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    role: row.role_key,
    roleLabel: row.role_label,
    level: row.level,
    orgId: row.org_unit_id,
    scopeOrgId: row.scope_org_id,
    buildingIds: row.building_ids,
    buildingId: row.home_building_id,
    room: row.home_room,
    permissions: row.permissions,
    status: row.status,
    accessExpiresAt: row.access_expires_at,
    invitedByName: row.invited_by_name,
    canInvite: row.can_invite,
    createdAt: row.created_at
  };
}

function mapWorkOrder(row) {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    orgId: row.org_id,
    buildingId: row.building_id,
    room: row.room,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    entryAllowed: row.entry_allowed,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueAt: row.due_at,
    internalNote: row.latest_internal_note,
    publicNoteCount: row.public_note_count
  };
}

export function createApp({ db, auth: authAdapter, mailer: mailAdapter, publicUrl, devMode = false, logMail = true }) {
  const mailer = mailAdapter ?? createMailer({ log: logMail });
  const auth = authAdapter ?? createLocalAuth({ db, mailer, publicUrl });
  const loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const emailLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), "([^/]+)"))}$`);
    routes.push({ method, regex, keys, handler, auth });
  };

  async function sendMail(tx, { to, subject, body, link }) {
    return mailer.send(tx, { to, subject, body, link });
  }

  async function startSession(response, request, userId) {
    const token = newToken();
    await db.asService(async (tx) => {
      await tx.query(
        "insert into server_private.sessions (token_hash, user_id, expires_at, user_agent) values ($1, $2, now() + make_interval(hours => $3), $4)",
        [hashToken(token), userId, SESSION_HOURS, text(request.headers["user-agent"], 200)]
      );
    });
    response.setHeader("set-cookie", sessionCookie(token, { secure: publicUrl.startsWith("https:") }));
  }

  async function sessionUser(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const { rows } = await db.asService((tx) => tx.query(
      "select user_id from server_private.sessions where token_hash = $1 and expires_at > now()", [hashToken(token)]
    ));
    return rows[0]?.user_id ?? null;
  }

  async function loadProfile(userId) {
    const { rows } = await db.asUser(userId, (tx) => tx.query("select * from public.my_profile()"));
    return mapProfile(rows[0]);
  }

  function accessProblem(profile) {
    if (!profile) return [403, "No profile is linked to this account.", "NO_PROFILE"];
    if (profile.status === "pending_verification") return [403, "Verify your email before signing in. Check your inbox for the link.", "EMAIL_NOT_VERIFIED"];
    if (profile.status === "suspended") return [403, "This account is suspended. Contact the department that manages your access.", "SUSPENDED"];
    if (profile.status === "expired" || (profile.accessExpiresAt && new Date(profile.accessExpiresAt) < new Date())) {
      return [403, "Your access period has ended. Ask the person who invited you to extend it.", "ACCESS_EXPIRED"];
    }
    return null;
  }

  /* ----- Session and sign-in ----- */

  route("GET", "/api/health", async () => {
    await db.asService((tx) => tx.query("select 1"));
    if (auth.settings) {
      const settings = await auth.settings();
      if (!settings.ok) throw new HttpError(503, "Authentication service is unavailable.");
    }
    return { ok: true, database: db.kind, auth: auth.kind };
  }, { auth: false });

  route("GET", "/api/session", async ({ userId }) => {
    const profile = userId ? await loadProfile(userId) : null;
    const usable = profile && !accessProblem(profile);
    return {
      user: usable ? profile : null,
      demo: devMode ? { accounts: demoAccounts() } : null
    };
  }, { auth: false });

  route("POST", "/api/auth/login", async ({ request, response, body }) => {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const ip = request.socket.remoteAddress;
    if (!loginLimiter(`${ip}|${email}`)) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");

    const user = await auth.signIn(email, password);
    if (!user) throw new HttpError(401, "Email or password is incorrect.");

    const profile = await loadProfile(user.userId);
    const problem = accessProblem(profile);
    if (problem) throw new HttpError(problem[0], problem[1], { code: problem[2] });
    const portal = portalFor(profile.role);
    if (body.portal && body.portal !== portal) {
      throw new HttpError(409, `This account signs in through the ${portal === "student" ? "Student" : portal === "partner" ? "Partner" : "Faculty & staff"} portal.`, { portal });
    }

    await startSession(response, request, user.userId);
    return { user: profile };
  }, { auth: false });

  route("POST", "/api/auth/logout", async ({ request, response }) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) await db.asService((tx) => tx.query("delete from server_private.sessions where token_hash = $1", [hashToken(token)]));
    response.setHeader("set-cookie", clearSessionCookie());
    return { ok: true };
  }, { auth: false });

  route("POST", "/api/auth/signup", async ({ request, body }) => {
    const email = normalizeEmail(body.email);
    const fullName = text(body.fullName, 120);
    const password = body.password;
    if (!emailLimiter(`signup|${request.socket.remoteAddress}`)) throw new HttpError(429, "Too many attempts. Try again later.");
    if (!fullName) throw new HttpError(400, "Enter your name.");
    if (!email.endsWith("@gsumail.gram.edu")) throw new HttpError(403, knownErrors.SIGNUP_REQUIRES_INVITATION[1], { code: "SIGNUP_REQUIRES_INVITATION" });
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem);
    const homeBuilding = buildings.find((b) => b.id === body.homeBuildingId && b.type === "residence" && !b.offline);
    await auth.signUpStudent({
      email,
      password,
      metadata: { full_name: fullName, home_building_id: homeBuilding?.id ?? null, home_room: text(body.homeRoom, 16) || null }
    });
    return { ok: true, message: `We sent a verification link to ${email}.` };
  }, { auth: false });

  route("POST", "/api/auth/resend-verification", async ({ request, body }) => {
    const email = normalizeEmail(body.email);
    if (!emailLimiter(`verify|${request.socket.remoteAddress}|${email}`)) throw new HttpError(429, "Too many attempts. Try again later.");
    await auth.resendVerification(email);
    return { ok: true, message: "If that account is waiting for verification, a new link is on its way." };
  }, { auth: false });

  route("POST", "/api/auth/verify", async ({ body }) => {
    const result = await auth.verifyEmail(text(body.token, 200));
    if (!result) throw new HttpError(410, "This verification link is invalid or expired. Request a new one from the sign-in page.");
    return { ok: true, email: result };
  }, { auth: false });

  route("POST", "/api/auth/forgot", async ({ request, body }) => {
    const email = normalizeEmail(body.email);
    if (!emailLimiter(`forgot|${request.socket.remoteAddress}|${email}`)) throw new HttpError(429, "Too many attempts. Try again later.");
    await auth.requestPasswordReset(email);
    return { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  }, { auth: false });

  route("POST", "/api/auth/reset", async ({ body }) => {
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const userId = await auth.resetPassword(text(body.token, 4096), body.password);
    if (!userId) throw new HttpError(410, "This reset link is invalid or expired. Request a new one.");
    await db.asService((tx) => tx.query("delete from server_private.sessions where user_id = $1", [userId]));
    return { ok: true };
  }, { auth: false });

  route("GET", "/api/invitations/preview", async ({ url }) => {
    const token = text(url.searchParams.get("token"), 200);
    const { rows } = await db.asAnon((tx) => tx.query("select * from public.invitation_preview($1)", [token]));
    if (!rows.length) throw new HttpError(404, knownErrors.INVITATION_INVALID[1]);
    const row = rows[0];
    return {
      email: row.email,
      fullName: row.full_name,
      roleLabel: row.role_label,
      orgName: row.org_name,
      inviterName: row.inviter_name,
      expiresAt: row.expires_at,
      status: row.status,
      accessDays: row.access_days,
      buildingNames: row.building_names,
      features: row.features
    };
  }, { auth: false });

  route("POST", "/api/auth/accept-invite", async ({ request, response, body }) => {
    const token = text(body.token, 200);
    const fullName = text(body.fullName, 120);
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    if (!fullName) throw new HttpError(400, "Enter your name.");
    const { rows: preview } = await db.asAnon((tx) => tx.query("select email, status from public.invitation_preview($1)", [token]));
    if (!preview.length || preview[0].status !== "pending") throw new HttpError(410, knownErrors.INVITATION_INVALID[1]);
    const userId = await auth.adminCreateUser({
      email: preview[0].email,
      password: body.password,
      metadata: { invitation_token: token, full_name: fullName }
    });
    await startSession(response, request, userId);
    return { user: await loadProfile(userId) };
  }, { auth: false });

  /* ----- Signed-in account ----- */

  route("PATCH", "/api/account", async ({ userId, body }) => {
    await db.asUser(userId, (tx) => tx.query("select public.update_my_profile($1, $2)", [text(body.fullName, 120), text(body.homeRoom, 16) || null]));
    return { user: await loadProfile(userId) };
  });

  route("POST", "/api/account/password", async ({ request, response, userId, body }) => {
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    const profile = await loadProfile(userId);
    if (!(await auth.checkPassword(profile.email, String(body.current || "")))) throw new HttpError(400, "Your current password is incorrect.");
    await auth.setPassword(userId, body.next);
    await db.asService(async (tx) => {
      await tx.query("delete from server_private.sessions where user_id = $1", [userId]);
    });
    await startSession(response, request, userId);
    return { ok: true };
  });

  /* ----- Work orders ----- */

  route("GET", "/api/work-orders", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query("select * from public.work_order_feed()"));
    return { workOrders: rows.map(mapWorkOrder) };
  });

  route("GET", "/api/work-orders/summary", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query("select * from public.work_order_summary()"));
    return {
      summary: rows.map((row) => ({ orgId: row.org_id, orgName: row.org_name, open: row.open_count, urgent: row.urgent_count, overdue: row.overdue_count, total: row.total_count }))
    };
  });

  route("POST", "/api/work-orders", async ({ userId, body }) => {
    const title = text(body.title, 120);
    const description = text(body.description, 2000);
    if (title.length < 3) throw new HttpError(400, "Add a short title (at least 3 characters).");
    if (!description) throw new HttpError(400, "Describe what's happening.");
    if (!categories.includes(body.category)) throw new HttpError(400, "Pick a category.");
    if (!priorities.includes(body.priority)) throw new HttpError(400, "Pick a priority.");
    const { rows } = await db.asUser(userId, (tx) => tx.query(
      `insert into public.work_orders (title, description, category, priority, building_id, room, entry_allowed, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'Tiger Ops web') returning id, number, org_id`,
      [title, description, body.category, body.priority, text(body.buildingId, 60), text(body.room, 40).toUpperCase(), Boolean(body.entryAllowed)]
    ));
    return { id: rows[0].id, ref: `WO-${rows[0].number}`, orgId: rows[0].org_id };
  });

  route("PATCH", "/api/work-orders/:id", async ({ userId, params, body }) => {
    if (!isUuid(params.id)) throw new HttpError(404, "Work order not found.");
    const sets = [];
    const values = [params.id];
    if (body.status !== undefined) {
      if (!statuses.includes(body.status)) throw new HttpError(400, "Unknown status.");
      values.push(body.status);
      sets.push(`status = $${values.length}`);
    }
    if (body.priority !== undefined) {
      if (!priorities.includes(body.priority)) throw new HttpError(400, "Unknown priority.");
      values.push(body.priority);
      sets.push(`priority = $${values.length}`);
    }
    if (body.assigneeId !== undefined) {
      if (body.assigneeId && !isUuid(body.assigneeId)) throw new HttpError(400, "Unknown assignee.");
      values.push(body.assigneeId || null);
      sets.push(`assignee_id = $${values.length}`);
    }
    if (!sets.length) throw new HttpError(400, "Nothing to change.");
    const { rows } = await db.asUser(userId, (tx) => tx.query(`update public.work_orders set ${sets.join(", ")} where id = $1 returning id`, values));
    if (!rows.length) throw new HttpError(404, "Work order not found or not editable by your role.");
    return { ok: true };
  });

  route("GET", "/api/work-orders/:id/timeline", async ({ userId, params }) => {
    if (!isUuid(params.id)) throw new HttpError(404, "Work order not found.");
    const { rows } = await db.asUser(userId, (tx) => tx.query("select * from public.work_order_timeline($1)", [params.id]));
    return { notes: rows.map((row) => ({ id: row.id, author: row.author_name, body: row.body, visibility: row.visibility, createdAt: row.created_at })) };
  });

  route("POST", "/api/work-orders/:id/notes", async ({ userId, params, body }) => {
    if (!isUuid(params.id)) throw new HttpError(404, "Work order not found.");
    const note = text(body.body, 2000);
    if (!note) throw new HttpError(400, "Write a note first.");
    const visibility = body.visibility === "public" ? "public" : "internal";
    await db.asUser(userId, (tx) => tx.query(
      "insert into public.work_order_notes (work_order_id, body, visibility) values ($1, $2, $3)", [params.id, note, visibility]
    ));
    return { ok: true };
  });

  route("GET", "/api/assignees", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query("select * from public.assignable_profiles()"));
    return { assignees: rows.map((row) => ({ id: row.id, name: row.full_name, roleLabel: row.role_label, orgId: row.org_unit_id, orgName: row.org_name })) };
  });

  route("GET", "/api/audit", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query(
      "select id, at, actor_label, action, target_type, target_label, detail, org_id from public.audit_events order by at desc limit 300"
    ));
    return { events: rows.map((row) => ({ id: String(row.id), at: row.at, actor: row.actor_label, action: row.action, targetType: row.target_type, target: row.target_label, detail: row.detail, orgId: row.org_id })) };
  });

  /* ----- Role-based AI copilot ----- */

  route("POST", "/api/agent/chat", async ({ userId, body }) => {
    const message = text(body.message, 1000);
    if (!message) throw new HttpError(400, "Ask the copilot something first.");
    const profile = await loadProfile(userId);
    const data = await db.asUser(userId, async (tx) => {
      const orders = await tx.query("select * from public.work_order_feed()");
      const totals = await tx.query("select * from public.work_order_summary()");
      return { orders: orders.rows.map(mapWorkOrder), totals: totals.rows };
    });
    return answerAgent({
      profile,
      message,
      workOrders: data.orders,
      summary: data.totals.map((row) => ({ orgId: row.org_id, orgName: row.org_name, open: row.open_count, urgent: row.urgent_count, overdue: row.overdue_count, total: row.total_count }))
    });
  });

  route("POST", "/api/agent/email", async ({ userId, body }) => {
    const profile = await loadProfile(userId);
    if (!["president", "housingDirector"].includes(profile.role)) throw new HttpError(403, "Email tools are not enabled for this role.");
    const to = normalizeEmail(body.to);
    const subject = text(body.subject, 160);
    const mailBody = text(body.body, 4000);
    if (!isCampusEmail(to)) throw new HttpError(400, "For this pilot, email recipients must use @gram.edu or @gsumail.gram.edu.");
    if (!subject || !mailBody) throw new HttpError(400, "The email needs a subject and message.");
    await db.asService(async (tx) => {
      await sendMail(tx, { to, subject, body: mailBody });
      await tx.query(
        `insert into public.audit_events (actor_id, actor_label, action, target_type, target_id, target_label, detail, org_id, metadata)
         values ($1, $2, 'Sent agent email', 'email', $3, $3, $4, $5, $6)`,
        [userId, profile.name, to, subject, profile.orgId, JSON.stringify({ channel: "demo_outbox", agent: true })]
      );
    });
    return { ok: true, delivery: "demo_outbox", message: `Email sent to ${to} and recorded in the audit log.` };
  });

  /* ----- People and invitations ----- */

  route("GET", "/api/people", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query(
      `select p.id, p.email, p.full_name, p.role_key, r.label as role_label, p.org_unit_id, p.building_ids, p.home_building_id,
              p.home_room, p.status, p.access_expires_at, p.last_sign_in_at, p.created_at, p.permissions,
              app.can_manage_profile(p) as can_manage, app.profile_label(p.invited_by) as invited_by_name, p.invited_by is not null as was_invited
       from public.profiles p join public.role_templates r on r.key = p.role_key
       order by p.full_name`
    ));
    return {
      people: rows.map((row) => ({
        id: row.id, email: row.email, name: row.full_name, role: row.role_key, roleLabel: row.role_label, orgId: row.org_unit_id,
        buildingIds: row.building_ids, buildingId: row.home_building_id, room: row.home_room, status: row.status,
        accessExpiresAt: row.access_expires_at, lastSignInAt: row.last_sign_in_at, createdAt: row.created_at,
        permissions: row.permissions, canManage: row.can_manage, invitedByName: row.was_invited ? row.invited_by_name : null
      }))
    };
  });

  route("PATCH", "/api/people/:id", async ({ userId, params, body }) => {
    if (!isUuid(params.id) || params.id === userId) throw new HttpError(403, knownErrors.PROFILE_NOT_MANAGEABLE[1]);
    const permissions = Array.isArray(body.permissions) ? body.permissions.map((item) => text(item, 60)) : null;
    await db.asUser(userId, (tx) => tx.query("select public.manage_profile($1, $2, $3, $4)", [params.id, text(body.action, 20), Number.isInteger(body.days) ? body.days : null, permissions]));
    if (["suspend", "end_access"].includes(body.action)) {
      await db.asService((tx) => tx.query("delete from server_private.sessions where user_id = $1", [params.id]));
    }
    return { ok: true };
  });

  route("GET", "/api/invitations", async ({ userId }) => {
    const { rows } = await db.asUser(userId, (tx) => tx.query(
      `select i.id, i.email, i.full_name, i.role_key, i.org_unit_id, i.building_ids, i.permissions, i.access_days, i.note,
              case when i.status = 'pending' and i.expires_at < now() then 'expired' else i.status::text end as status,
              app.profile_label(i.invited_by) as invited_by_name, i.expires_at, i.accepted_at, i.created_at,
              app.can_manage_invitation(i.id) as can_manage
       from public.invitations i order by i.created_at desc`
    ));
    return {
      invitations: rows.map((row) => ({
        id: row.id, email: row.email, name: row.full_name, role: row.role_key, roleLabel: roleTemplates[row.role_key]?.label ?? row.role_key,
        orgId: row.org_unit_id, buildingIds: row.building_ids, permissions: row.permissions, accessDays: row.access_days, note: row.note,
        status: row.status, invitedByName: row.invited_by_name, expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at,
        canManage: row.can_manage
      }))
    };
  });

  async function deliverInvitation(userId, invitationId, token, expiresAt, email) {
    const link = `${publicUrl}/?invite=${token}`;
    const inviter = await loadProfile(userId);
    await db.asService((tx) => sendMail(tx, {
      to: email,
      subject: `${inviter.name} invited you to Tiger Ops`,
      body: `${inviter.name} (${inviter.roleLabel}) invited you to Grambling State's Tiger Ops campus operations workspace. The link expires ${new Date(expiresAt).toUTCString()}.`,
      link
    }));
    return { id: invitationId, link, expiresAt };
  }

  route("POST", "/api/invitations", async ({ userId, body }) => {
    const email = normalizeEmail(body.email);
    const accessDays = body.accessDays === null || body.accessDays === undefined || body.accessDays === "" ? null : Number(body.accessDays);
    const { rows } = await db.asUser(userId, (tx) => tx.query(
      "select * from public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        email,
        text(body.role, 60),
        text(body.orgId, 60),
        Array.isArray(body.buildingIds) ? body.buildingIds.map((id) => text(id, 60)) : [],
        Array.isArray(body.permissions) ? body.permissions.map((p) => text(p, 60)) : null,
        Number.isInteger(accessDays) ? accessDays : null,
        Number.isInteger(body.validHours) ? body.validHours : 72,
        text(body.fullName, 120) || null,
        text(body.note, 500) || null
      ]
    ));
    return deliverInvitation(userId, rows[0].invitation_id, rows[0].token, rows[0].expires_at, email);
  });

  route("POST", "/api/invitations/:id/revoke", async ({ userId, params }) => {
    if (!isUuid(params.id)) throw new HttpError(404, "Invitation not found.");
    await db.asUser(userId, (tx) => tx.query("select public.revoke_invitation($1)", [params.id]));
    return { ok: true };
  });

  route("POST", "/api/invitations/:id/resend", async ({ userId, params }) => {
    if (!isUuid(params.id)) throw new HttpError(404, "Invitation not found.");
    const { rows } = await db.asUser(userId, (tx) => tx.query("select r.*, i.email from public.resend_invitation($1) r join public.invitations i on i.id = r.invitation_id", [params.id]));
    return deliverInvitation(userId, rows[0].invitation_id, rows[0].token, rows[0].expires_at, rows[0].email);
  });

  /* ----- Local development ----- */

  if (devMode) {
    route("GET", "/api/dev/mailbox", async () => {
      const { rows } = await db.asService((tx) => tx.query("select id, to_email, subject, body, link, created_at from server_private.outbox order by id desc limit 50"));
      return { messages: rows.map((row) => ({ id: row.id, to: row.to_email, subject: row.subject, body: row.body, link: row.link, createdAt: row.created_at })) };
    }, { auth: false });
  }

  return async function handle(request, response) {
    const url = new URL(request.url || "/", publicUrl);
    try {
      if (!url.pathname.startsWith("/api/")) {
        const file = staticFiles.get(url.pathname);
        const filePath = file ? resolve(root, file) : null;
        if (request.method !== "GET" || !filePath || !existsSync(filePath)) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        response.writeHead(200, {
          "content-type": mime[extname(filePath)],
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY"
        });
        createReadStream(filePath).pipe(response);
        return;
      }

      // Cross-site requests can't carry the Lax cookie on POST, but check Origin too.
      if (request.method !== "GET") {
        const origin = request.headers.origin;
        if (origin && origin !== new URL(publicUrl).origin && origin !== `http://${request.headers.host}`) {
          throw new HttpError(403, "Cross-origin request blocked.");
        }
      }

      const match = routes.find((item) => item.method === request.method && item.regex.test(url.pathname));
      if (!match) throw new HttpError(404, "Not found.");
      const values = url.pathname.match(match.regex).slice(1);
      const params = Object.fromEntries(match.keys.map((key, index) => [key, decodeURIComponent(values[index])]));
      const userId = await sessionUser(request);
      if (match.auth && !userId) throw new HttpError(401, "Please sign in.");
      const body = ["POST", "PATCH"].includes(request.method) ? await readJson(request) : {};
      const result = await match.handler({ request, response, url, params, body, userId });
      send(response, 200, result);
    } catch (error) {
      const known = toHttpError(error);
      if (!known) {
        console.error(error);
        send(response, 500, { error: "Something went wrong. Try again." });
        return;
      }
      send(response, known.status, { error: known.message, ...known.extra });
    }
  };
}

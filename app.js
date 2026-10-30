import { ApiError, api } from "./api.js";
import {
  buildingTypes,
  buildings,
  campusStreets,
  featureLabels,
  organization,
  personas,
  researchNotes,
  roleTemplates
} from "./data.js";
import { generateFloorPlan, isBookableSpace, modeledRoomState } from "./floorplans.js";
import {
  canAssignWorkOrder,
  canCreateWorkOrder,
  canUpdateWorkOrder,
  canViewFloorPlan,
  canViewOccupancy,
  getDescendantIds,
  getRole,
  getScopedOrgIds,
  hasPermission,
  isBuildingInScope,
  permissionDecision
} from "./permissions.js";

const viewTitles = {
  overview: "Command overview",
  "work-orders": "Work order center",
  map: "Campus map",
  floors: "Floor plans",
  organization: "Organization and access",
  people: "People and invitations",
  audit: "Audit history",
  account: "My account"
};
const statusLabels = {
  triage: "Triage",
  assigned: "Assigned",
  in_progress: "In progress",
  waiting_parts: "Waiting for parts",
  completed: "Completed",
  cancelled: "Cancelled"
};
const portals = {
  student: {
    tab: "Students",
    title: "Student sign in",
    hint: "Use your @gsumail.gram.edu email.",
    placeholder: "you@gsumail.gram.edu"
  },
  staff: {
    tab: "Faculty & staff",
    title: "Faculty & staff sign in",
    hint: "Use the email address your invitation was sent to.",
    placeholder: "you@gram.edu"
  },
  partner: {
    tab: "Partners",
    title: "Contractor & partner sign in",
    hint: "Use the email address your invitation was sent to. Partner access ends automatically.",
    placeholder: "you@company.com"
  }
};

const bootScreen = document.querySelector("#boot-screen");
const authRoot = document.querySelector("#auth-root");
const appShell = document.querySelector("#app-shell");
const pageRoot = document.querySelector("#view-root");
const pageTitle = document.querySelector("#page-title");
const workOrderCount = document.querySelector("#work-order-count");
const workOrderDialog = document.querySelector("#work-order-dialog");
const workOrderDialogContent = document.querySelector("#work-order-dialog-content");
const createDialog = document.querySelector("#create-dialog");
const createForm = document.querySelector("#create-work-order-form");
const toast = document.querySelector("#toast");
const sidebar = document.querySelector(".sidebar");
const mobileMenu = document.querySelector("#mobile-menu");
const userChip = document.querySelector("#user-chip");
const userPopover = document.querySelector("#user-popover");
const agentLauncher = document.querySelector("#agent-launcher");
const agentPanel = document.querySelector("#agent-panel");
const agentMessages = document.querySelector("#agent-messages");
const agentSuggestions = document.querySelector("#agent-suggestions");
const agentForm = document.querySelector("#agent-form");
const agentInput = document.querySelector("#agent-input");
const agentMic = document.querySelector("#agent-mic");
const agentVoice = document.querySelector("#agent-voice");
const agentRuntime = document.querySelector("#agent-runtime");

const initialHash = window.location.hash.slice(1);
const initialAuthHash = initialHash.includes("access_token=") ? new URLSearchParams(initialHash) : null;
const hashView = initialAuthHash ? "" : initialHash;
const state = {
  user: null,
  demo: null,
  activeView: viewTitles[hashView] ? hashView : "overview",
  workOrders: [],
  summary: [],
  auditEvents: [],
  people: [],
  invitations: [],
  assignees: null,
  selectedBuildingId: "mildred-jones",
  selectedFloor: 2,
  selectedSpaceId: null,
  mapFilter: "all",
  mapQuery: "",
  mapMode: "3d",
  routeActive: false,
  userMapPoint: null,
  locationMessage: "",
  showOccupancy: true,
  showWork: true,
  planAsTable: false,
  orderFilter: "open",
  peopleTab: "people",
  peopleFilter: "all",
  peopleQuery: "",
  inviteDraft: null,
  agent: { open: false, busy: false, voice: true, listening: false, pending: null, messages: [], suggestions: [] },
  auth: { mode: "login", portal: "student", error: "", notice: "", code: null, email: "", token: null, preview: null, busy: false, mailbox: [] }
};

/* ---------- Utilities ---------- */

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value, includeTime = true) {
  if (!value) return "—";
  const options = includeTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" };
  return new Intl.DateTimeFormat("en-US", options).format(new Date(value));
}

function relativeAge(value) {
  const diffHours = Math.round((Date.now() - new Date(value).getTime()) / 3_600_000);
  if (Math.abs(diffHours) < 1) return "Just now";
  if (Math.abs(diffHours) < 24) return `${Math.abs(diffHours)}h ago`;
  return `${Math.round(Math.abs(diffHours) / 24)}d ago`;
}

function daysUntil(value) {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}

function accessLabel(value) {
  if (!value) return "No end date";
  const days = daysUntil(value);
  if (days < 0) return `Ended ${formatDate(value, false)}`;
  if (days === 0) return "Ends today";
  return `${days} day${days === 1 ? "" : "s"} left · ${formatDate(value, false)}`;
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function getBuilding(buildingId) {
  return buildings.find((building) => building.id === buildingId);
}

function buildingName(buildingId) {
  return getBuilding(buildingId)?.name || "Unknown building";
}

function orgName(orgId) {
  return organization.find((unit) => unit.id === orgId)?.name || "—";
}

function isOpen(order) {
  return !["completed", "cancelled"].includes(order.status);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function badge(value, label = null) {
  const normalized = String(value).replaceAll("_", "-");
  return `<span class="badge ${escapeHtml(normalized)}">${escapeHtml(label || statusLabels[value] || titleCase(value))}</span>`;
}

function me() {
  return state.user;
}

function role() {
  return getRole(state.user);
}

function canSeePeople() {
  return hasPermission(me(), "people:view") || hasPermission(me(), "people:invite");
}

function hasAuditDetail() {
  return role().permissions.some((permission) => permission === "audit:view:department" || permission === "audit:view:institution");
}

// Runs an action and turns failures into a toast, or back to sign-in on 401.
async function guard(task) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && state.user) {
      signedOut("Your session ended. Sign in again.");
      return undefined;
    }
    showToast(error.message || "Something went wrong.");
    return undefined;
  }
}

/* ---------- Authentication screens ---------- */

function setAuth(patch) {
  Object.assign(state.auth, patch);
  renderAuth();
}

function showAuth(mode, patch = {}) {
  state.user = null;
  appShell.hidden = true;
  bootScreen.hidden = true;
  authRoot.hidden = false;
  document.title = "Sign in | Tiger Ops";
  state.auth = { ...state.auth, mode, error: "", notice: "", code: null, busy: false, ...patch };
  renderAuth();
  if (mode === "invite") loadInvitePreview();
  if (mode === "verify") runVerification();
  if (mode === "mailbox") loadMailbox();
}

function brandPanel() {
  return `
    <section class="auth-brand" aria-label="About Tiger Ops">
      <div class="brand-block"><div class="brand-mark" aria-hidden="true">G</div><div><strong>Tiger Ops</strong><span>Grambling State University</span></div></div>
      <div class="auth-brand-copy">
        <h1>One place to report, route, and resolve campus work.</h1>
        <ul>
          <li><strong>Students</strong> report problems and follow every step without calling three offices.</li>
          <li><strong>Departments</strong> see only the work, halls, and people inside their scope.</li>
          <li><strong>Leaders</strong> get the signal without opening private records.</li>
        </ul>
      </div>
      <p class="auth-footnote">Pilot workspace · synthetic data · access enforced by row-level security</p>
    </section>`;
}

function authAlert() {
  const { error, notice } = state.auth;
  return `${error ? `<div class="form-alert error" role="alert">${escapeHtml(error)}</div>` : ""}${notice ? `<div class="form-alert success" role="status">${escapeHtml(notice)}</div>` : ""}`;
}

function demoPanel(portal) {
  if (!state.demo) return "";
  const accounts = state.demo.accounts.filter((account) => account.kind === portal);
  if (!accounts.length) return "";
  return `
    <details class="demo-accounts" ${portal === "staff" ? "open" : ""}>
      <summary>Demo accounts <span>click to sign in</span></summary>
      <ul>${accounts.map((account) => `<li><button type="button" class="demo-account" data-demo-email="${escapeHtml(account.email)}"><strong>${escapeHtml(account.role)}</strong><span>${escapeHtml(account.email)}<br><code>${escapeHtml(account.password)}</code></span></button></li>`).join("")}</ul>
    </details>`;
}

function passwordFields(label = "Password") {
  return `
    <label>${escapeHtml(label)}<input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200" aria-describedby="password-help" /></label>
    <label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="200" /></label>
    <small id="password-help" class="field-help">At least 10 characters, with a letter and a number.</small>`;
}

function renderLogin() {
  const portal = portals[state.auth.portal];
  return `
    <div class="portal-tabs" role="tablist" aria-label="Choose how you sign in">
      ${Object.entries(portals).map(([key, item]) => `<button type="button" role="tab" class="portal-tab ${state.auth.portal === key ? "is-active" : ""}" aria-selected="${state.auth.portal === key}" data-portal="${key}">${escapeHtml(item.tab)}</button>`).join("")}
    </div>
    <h2>${escapeHtml(portal.title)}</h2>
    <p class="auth-hint">${escapeHtml(portal.hint)}</p>
    ${authAlert()}
    ${state.auth.code === "EMAIL_NOT_VERIFIED" ? `<button type="button" class="button secondary" data-auth-action="resend-verification">Resend verification email</button>` : ""}
    <form class="form-stack" data-auth-form="login" novalidate>
      <label>Email<input name="email" type="email" autocomplete="username" required placeholder="${escapeHtml(portal.placeholder)}" value="${escapeHtml(state.auth.email)}" /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      <button class="button primary wide" ${state.auth.busy ? "disabled" : ""}>${state.auth.busy ? "Signing in…" : "Sign in"}</button>
    </form>
    <div class="auth-links">
      <button type="button" class="link-button" data-auth-mode="forgot">Forgot password?</button>
      ${state.auth.portal === "student" ? `<span>New student? <button type="button" class="link-button" data-auth-mode="signup">Create your account</button></span>` : `<span>Need access? Ask your department head for an invitation.</span>`}
    </div>
    ${demoPanel(state.auth.portal)}`;
}

function renderSignup() {
  const halls = buildings.filter((building) => building.type === "residence" && !building.offline).sort((a, b) => a.name.localeCompare(b.name));
  return `
    <button type="button" class="link-button back" data-auth-mode="login">← Back to sign in</button>
    <h2>Create your student account</h2>
    <p class="auth-hint">Only <strong>@gsumail.gram.edu</strong> addresses can self-register. We'll email you a link to confirm it's yours.</p>
    ${authAlert()}
    <form class="form-stack" data-auth-form="signup" novalidate>
      <label>Full name<input name="fullName" autocomplete="name" required maxlength="120" /></label>
      <label>Student email<input name="email" type="email" autocomplete="email" required placeholder="you@gsumail.gram.edu" value="${escapeHtml(state.auth.email)}" /></label>
      <div class="form-row">
        <label><span>Residence hall <span class="optional">optional</span></span>
          <select name="homeBuildingId"><option value="">Off campus / not assigned yet</option>${halls.map((hall) => `<option value="${hall.id}">${escapeHtml(hall.name)}</option>`).join("")}</select>
        </label>
        <label><span>Room <span class="optional">optional</span></span><input name="homeRoom" maxlength="16" placeholder="e.g. 203" /></label>
      </div>
      ${passwordFields()}
      <label class="checkbox-row"><input type="checkbox" name="agree" required /> I'll use Tiger Ops under GSU's acceptable-use policy.</label>
      <button class="button primary wide" ${state.auth.busy ? "disabled" : ""}>${state.auth.busy ? "Creating account…" : "Create account"}</button>
    </form>`;
}

function renderCheckEmail() {
  return `
    <h2>Check your inbox</h2>
    ${authAlert()}
    <p>Open the link we sent to <strong>${escapeHtml(state.auth.email)}</strong> to activate your account. It works for 48 hours.</p>
    <div class="auth-actions">
      <button type="button" class="button secondary" data-auth-action="resend-verification">Resend the email</button>
      ${state.demo ? `<button type="button" class="button primary" data-auth-mode="mailbox">Open dev mailbox</button>` : ""}
    </div>
    <button type="button" class="link-button back" data-auth-mode="login">← Back to sign in</button>`;
}

function renderInvite() {
  const preview = state.auth.preview;
  if (!preview) return `<h2>Checking your invitation…</h2>${authAlert()}`;
  if (preview.status !== "pending") {
    return `<h2>This invitation can't be used</h2>
      <div class="form-alert error" role="alert">${escapeHtml(state.auth.error || `It was ${preview.status}. Ask ${preview.inviterName} to send a new one.`)}</div>
      <button type="button" class="link-button back" data-auth-mode="login">← Back to sign in</button>`;
  }
  return `
    <span class="eyebrow">Invitation from ${escapeHtml(preview.inviterName)}</span>
    <h2>Join as ${escapeHtml(preview.roleLabel)}</h2>
    <div class="invite-card">
      <div><span>Department</span><strong>${escapeHtml(preview.orgName)}</strong></div>
      <div><span>Access</span><strong>${preview.accessDays ? `${preview.accessDays} days from today` : "No end date"}</strong></div>
      ${preview.buildingNames.length ? `<div class="span-2"><span>Halls</span><strong>${preview.buildingNames.map(escapeHtml).join(", ")}</strong></div>` : ""}
      <div class="span-2"><span>What you'll be able to do</span><ul class="feature-pills">${preview.features.map((feature) => `<li>${escapeHtml(featureLabels[feature] || feature)}</li>`).join("")}</ul></div>
      <div class="span-2"><span>Link expires</span><strong>${formatDate(preview.expiresAt)}</strong></div>
    </div>
    ${authAlert()}
    <form class="form-stack" data-auth-form="accept-invite" novalidate>
      <label>Email<input type="email" value="${escapeHtml(preview.email)}" readonly /></label>
      <label>Full name<input name="fullName" autocomplete="name" required maxlength="120" value="${escapeHtml(preview.fullName || "")}" /></label>
      ${passwordFields("Choose a password")}
      <button class="button primary wide" ${state.auth.busy ? "disabled" : ""}>${state.auth.busy ? "Creating account…" : "Accept and create account"}</button>
    </form>`;
}

function renderVerify() {
  return `
    <h2>${state.auth.notice ? "Email confirmed" : state.auth.error ? "We couldn't confirm that link" : "Confirming your email…"}</h2>
    ${authAlert()}
    ${state.auth.notice || state.auth.error ? `<button type="button" class="button primary" data-auth-mode="login">Go to sign in</button>` : ""}`;
}

function renderForgot() {
  return `
    <button type="button" class="link-button back" data-auth-mode="login">← Back to sign in</button>
    <h2>Reset your password</h2>
    <p class="auth-hint">We'll email a link that works for one hour.</p>
    ${authAlert()}
    <form class="form-stack" data-auth-form="forgot" novalidate>
      <label>Email<input name="email" type="email" autocomplete="email" required value="${escapeHtml(state.auth.email)}" /></label>
      <button class="button primary wide" ${state.auth.busy ? "disabled" : ""}>Send reset link</button>
    </form>
    ${state.demo && state.auth.notice ? `<button type="button" class="button secondary" data-auth-mode="mailbox">Open dev mailbox</button>` : ""}`;
}

function renderReset() {
  return `
    <h2>Choose a new password</h2>
    ${authAlert()}
    <form class="form-stack" data-auth-form="reset" novalidate>
      ${passwordFields("New password")}
      <button class="button primary wide" ${state.auth.busy ? "disabled" : ""}>Save password</button>
    </form>`;
}

function renderMailbox() {
  const messages = state.auth.mailbox;
  return `
    <button type="button" class="link-button back" data-auth-mode="login">← Back to sign in</button>
    <span class="eyebrow">Local development only</span>
    <h2>Dev mailbox</h2>
    <p class="auth-hint">Emails the local server would have sent. On Supabase these go through your email provider.</p>
    <button type="button" class="button secondary" data-auth-action="refresh-mailbox">Refresh</button>
    <ul class="mailbox">${messages.length ? messages.map((message) => `
      <li>
        <div class="mail-meta"><strong>${escapeHtml(message.subject)}</strong><span>To ${escapeHtml(message.to)} · ${relativeAge(message.createdAt)}</span></div>
        <p>${escapeHtml(message.body)}</p>
        ${message.link ? `<a class="button primary" href="${escapeHtml(message.link)}">Open link</a>` : ""}
      </li>`).join("") : `<li class="empty-state">No messages yet.</li>`}</ul>`;
}

function renderAuth() {
  const views = { login: renderLogin, signup: renderSignup, "check-email": renderCheckEmail, invite: renderInvite, verify: renderVerify, forgot: renderForgot, reset: renderReset, mailbox: renderMailbox };
  authRoot.innerHTML = `<div class="auth-layout">${brandPanel()}<main class="auth-panel" id="auth-main"><div class="auth-card">${(views[state.auth.mode] || renderLogin)()}</div></main></div>`;
}

async function loadInvitePreview() {
  try {
    const preview = await api.get(`/api/invitations/preview?token=${encodeURIComponent(state.auth.token)}`);
    setAuth({ preview });
  } catch (error) {
    setAuth({ preview: { status: "invalid", inviterName: "the sender" }, error: error.message });
  }
}

async function runVerification() {
  try {
    const result = await api.post("/api/auth/verify", { token: state.auth.token });
    window.history.replaceState(null, "", "/");
    setAuth({ notice: `${result.email} is confirmed. You can sign in now.`, portal: "student", email: result.email });
  } catch (error) {
    setAuth({ error: error.message });
  }
}

async function loadMailbox() {
  try {
    const { messages } = await api.get("/api/dev/mailbox");
    setAuth({ mailbox: messages });
  } catch (error) {
    setAuth({ error: error.message });
  }
}

function readPasswords(form) {
  const password = form.elements.password.value;
  if (password !== form.elements.confirm.value) return { error: "Passwords don't match." };
  return { password };
}

async function submitAuthForm(form) {
  const kind = form.dataset.authForm;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  state.auth.busy = true;
  state.auth.error = "";
  state.auth.notice = "";
  state.auth.code = null;
  renderAuth();
  try {
    if (kind === "login") {
      const email = String(data.get("email")).trim();
      state.auth.email = email;
      const { user } = await api.post("/api/auth/login", { email, password: data.get("password"), portal: state.auth.portal });
      await enterApp(user);
      return;
    }
    if (kind === "signup") {
      const { password, error } = readPasswords(form);
      if (error) throw new Error(error);
      const email = String(data.get("email")).trim().toLowerCase();
      await api.post("/api/auth/signup", { email, password, fullName: data.get("fullName"), homeBuildingId: data.get("homeBuildingId") || null, homeRoom: data.get("homeRoom") });
      setAuth({ mode: "check-email", email, busy: false });
      return;
    }
    if (kind === "accept-invite") {
      const { password, error } = readPasswords(form);
      if (error) throw new Error(error);
      const { user } = await api.post("/api/auth/accept-invite", { token: state.auth.token, fullName: data.get("fullName"), password });
      await enterApp(user);
      showToast("Welcome to Tiger Ops. Your access is ready.");
      return;
    }
    if (kind === "forgot") {
      const email = String(data.get("email")).trim();
      const result = await api.post("/api/auth/forgot", { email });
      setAuth({ notice: result.message, email, busy: false });
      return;
    }
    if (kind === "reset") {
      const { password, error } = readPasswords(form);
      if (error) throw new Error(error);
      await api.post("/api/auth/reset", { token: state.auth.token, password });
      window.history.replaceState(null, "", "/");
      setAuth({ mode: "login", notice: "Password updated. Sign in with your new password.", busy: false });
    }
  } catch (error) {
    const patch = { busy: false, error: error.message, code: error.code ?? null };
    if (error instanceof ApiError && error.body?.portal) {
      patch.portal = error.body.portal;
      patch.error = `${error.message} We've switched tabs for you. Sign in again.`;
    }
    setAuth(patch);
  }
}

authRoot.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-auth-form]");
  if (!form) return;
  event.preventDefault();
  submitAuthForm(form);
});

authRoot.addEventListener("click", async (event) => {
  const portal = event.target.closest("[data-portal]");
  if (portal) {
    setAuth({ portal: portal.dataset.portal, error: "", notice: "", code: null });
    return;
  }
  const mode = event.target.closest("[data-auth-mode]");
  if (mode) {
    window.history.replaceState(null, "", "/");
    showAuth(mode.dataset.authMode, { token: null });
    return;
  }
  const demo = event.target.closest("[data-demo-email]");
  if (demo) {
    const form = authRoot.querySelector('[data-auth-form="login"]');
    form.elements.email.value = demo.dataset.demoEmail;
    form.elements.password.value = state.demo.accounts.find((account) => account.email === demo.dataset.demoEmail).password;
    submitAuthForm(form);
    return;
  }
  const action = event.target.closest("[data-auth-action]")?.dataset.authAction;
  if (action === "resend-verification") {
    const email = state.auth.email || authRoot.querySelector('input[name="email"]')?.value;
    try {
      const result = await api.post("/api/auth/resend-verification", { email });
      setAuth({ notice: result.message, error: "", code: null });
    } catch (error) {
      setAuth({ error: error.message });
    }
  }
  if (action === "refresh-mailbox") loadMailbox();
});

/* ---------- Session ---------- */

async function enterApp(user) {
  state.user = user;
  state.assignees = null;
  state.agent.messages = [{ role: "assistant", text: user.role === "president"
    ? "I’m Tiger, your executive campus copilot. I can brief approved aggregates, draft communications, and navigate the campus digital twin."
    : user.role === "housingDirector"
      ? "I’m Tiger, your Housing operations copilot. I can navigate campus, summarize your scoped queue, and prepare confirmed work-order or email actions."
      : "I’m Tiger, your campus guide. I can help you find buildings and open the right workspace for your role." }];
  state.agent.suggestions = ["Show me Bowen", "Give me an operations summary", user.role === "housingDirector" ? "Resolve WO-1048" : "Open the campus map"];
  authRoot.hidden = true;
  bootScreen.hidden = true;
  appShell.hidden = false;
  agentLauncher.hidden = false;
  window.history.replaceState(null, "", `/#${state.activeView}`);
  document.title = "Tiger Ops | Campus Operations";
  renderUserChrome();
  await loadData();
  render();
  renderAgent();
}

function signedOut(message = "") {
  state.workOrders = [];
  state.summary = [];
  state.auditEvents = [];
  state.people = [];
  state.invitations = [];
  state.agent.open = false;
  agentLauncher.hidden = true;
  agentPanel.hidden = true;
  if (workOrderDialog.open) workOrderDialog.close();
  if (createDialog.open) createDialog.close();
  window.history.replaceState(null, "", "/");
  showAuth("login", { notice: message, portal: state.auth.portal });
}

async function signOut() {
  await api.post("/api/auth/logout").catch(() => {});
  signedOut("You're signed out.");
}

async function loadData() {
  const user = me();
  const tasks = [];
  state.workOrders = [];
  state.summary = [];
  state.auditEvents = [];
  if (hasPermission(user, "work_order:view")) tasks.push(api.get("/api/work-orders").then((r) => { state.workOrders = r.workOrders; }));
  if (hasPermission(user, "work_order:view:summary")) tasks.push(api.get("/api/work-orders/summary").then((r) => { state.summary = r.summary; }));
  if (hasAuditDetail()) tasks.push(api.get("/api/audit").then((r) => { state.auditEvents = r.events; }));
  if (canSeePeople()) tasks.push(loadPeople());
  await guard(() => Promise.all(tasks));
}

async function loadPeople() {
  const [people, invitations] = await Promise.all([api.get("/api/people"), api.get("/api/invitations")]);
  state.people = people.people;
  state.invitations = invitations.invitations;
}

function renderUserChrome() {
  const user = me();
  document.querySelector("#user-initials").textContent = initials(user.name);
  document.querySelector("#user-name").textContent = user.name;
  document.querySelector("#user-role").textContent = user.roleLabel;
  document.querySelector("#mailbox-link").hidden = !state.demo;
  document.querySelectorAll('[data-requires="people"]').forEach((item) => { item.hidden = !canSeePeople(); });
}

/* ---------- Overview and work orders ---------- */

function roleScopeLabel() {
  const user = me();
  const r = role();
  if (r.scopeMode === "own") return "Own requests only";
  if (r.scopeMode === "assigned") return "Assigned jobs only";
  if (r.aggregateOnly) return `${orgName(r.scopeOrgId)} aggregates`;
  if (r.buildingScoped) return `${orgName(r.scopeOrgId)} · ${user.buildingIds.length} hall${user.buildingIds.length === 1 ? "" : "s"}`;
  return `${orgName(r.scopeOrgId)} + nested teams`;
}

function metricCard(label, value, helper, trend = false) {
  return `<article class="metric-card"><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small class="${trend ? "trend" : ""}">${escapeHtml(helper)}</small></article>`;
}

// Synthetic occupancy, corrected for the signed-in resident's own room.
function roomState(buildingId, space) {
  const room = modeledRoomState(buildingId, space);
  const mine = me()?.buildingId === buildingId && me()?.room === space.id;
  return room && mine ? { ...room, occupied: Math.max(1, room.occupied), readiness: "ready" } : room;
}

function computeReadiness() {
  const scoped = buildings.filter((building) => building.type === "residence" && !building.offline && canViewOccupancy(me(), building));
  let beds = 0;
  let occupied = 0;
  for (const building of scoped) {
    for (let floor = 1; floor <= building.floors; floor += 1) {
      for (const space of generateFloorPlan(building, floor).spaces) {
        const room = roomState(building.id, space);
        if (!room) continue;
        beds += room.beds;
        occupied += room.occupied;
      }
    }
  }
  return { halls: scoped.length, beds, occupied };
}

function computeMetrics() {
  if (role().aggregateOnly) {
    const sum = (key) => state.summary.reduce((total, row) => total + row[key], 0);
    return { open: sum("open"), urgent: sum("urgent"), overdue: sum("overdue") };
  }
  const now = Date.now();
  const open = state.workOrders.filter(isOpen);
  return {
    open: open.length,
    urgent: open.filter((order) => order.priority !== "routine").length,
    overdue: open.filter((order) => order.dueAt && new Date(order.dueAt).getTime() < now).length
  };
}

function filteredOrders() {
  const orders = state.workOrders;
  if (state.orderFilter === "all") return orders;
  if (state.orderFilter === "open") return orders.filter(isOpen);
  if (state.orderFilter === "urgent") return orders.filter((order) => isOpen(order) && order.priority !== "routine");
  if (state.orderFilter === "unassigned") return orders.filter((order) => isOpen(order) && !order.assigneeName);
  if (state.orderFilter === "completed") return orders.filter((order) => !isOpen(order));
  return orders;
}

function renderHero() {
  const user = me();
  const r = role();
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Chicago" }).format(new Date()));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const expiring = user.accessExpiresAt && daysUntil(user.accessExpiresAt) <= 14;
  // Demo and shared accounts are often named by title; don't greet "University".
  const titleLike = /president|director|executive|\bvp\b|dispatcher|reviewer|requester|staff|team|crew|operations|\bresident\b/i.test(user.name);
  const firstName = titleLike ? "" : user.name.split(" ")[0];
  return `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">${escapeHtml(r.level)} workspace</span>
        <h1>${escapeHtml(`${greeting}${firstName ? `, ${firstName}` : ""}.`)}</h1>
        <p>${escapeHtml(r.explanation)}</p>
        ${expiring ? `<p class="hero-warning">Your access ends ${escapeHtml(formatDate(user.accessExpiresAt, false))}. Ask ${escapeHtml(user.invitedByName || "your department")} to extend it.</p>` : ""}
      </div>
      <div class="hero-side">
        <div class="scope-chip"><span>Role</span><strong>${escapeHtml(r.label)}</strong></div>
        <div class="scope-chip"><span>Data scope</span><strong>${escapeHtml(roleScopeLabel())}</strong></div>
      </div>
    </section>`;
}

function renderOrderRows(orders, limit = null) {
  const shown = limit ? orders.slice(0, limit) : orders;
  if (!shown.length) return `<tr><td colspan="6"><div class="empty-state">No work orders match this view.</div></td></tr>`;
  return shown
    .map((order) => `
      <tr data-order-id="${escapeHtml(order.id)}" tabindex="0" aria-label="Open ${escapeHtml(order.ref)} ${escapeHtml(order.title)}">
        <td><span class="ticket-id">${escapeHtml(order.ref)}</span><span class="ticket-title">${escapeHtml(order.title)}</span></td>
        <td>${escapeHtml(buildingName(order.buildingId))}<br><span class="ticket-id">${escapeHtml(order.room)}</span></td>
        <td>${badge(order.status)}</td>
        <td>${badge(order.priority)}</td>
        <td>${order.assigneeName ? `<span class="assignee-cell"><span class="avatar">${escapeHtml(initials(order.assigneeName))}</span>${escapeHtml(order.assigneeName)}</span>` : "Unassigned"}</td>
        <td>${formatDate(order.updatedAt)}</td>
      </tr>`)
    .join("");
}

function ordersTable(orders, limit = null) {
  return `<div class="table-wrap"><table><thead><tr><th>Work order</th><th>Location</th><th>Status</th><th>Priority</th><th>Assigned to</th><th>Updated</th></tr></thead><tbody>${renderOrderRows(orders, limit)}</tbody></table></div>`;
}

function compactOrders(orders) {
  return `<ul class="compact-orders">${orders.map((order) => `<li><button data-order-id="${escapeHtml(order.id)}"><span class="ticket-id">${escapeHtml(order.ref)} · ${escapeHtml(order.room)}</span><strong>${escapeHtml(order.title)}</strong><span>${badge(order.status)} ${badge(order.priority)}</span></button></li>`).join("")}</ul>`;
}

function summaryTable() {
  const rows = state.summary.map((row) => `<tr><td><strong>${escapeHtml(row.orgName)}</strong></td><td>${row.open}</td><td>${row.urgent}</td><td>${row.overdue}</td><td>${row.total}</td></tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Department</th><th>Open</th><th>Urgent</th><th>Overdue</th><th>Total</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No operational records in scope.</td></tr>`}</tbody></table></div>`;
}

function renderOverview() {
  const user = me();
  const r = role();
  const metrics = computeMetrics();
  const isStudent = user.role === "student";
  const readiness = computeReadiness();
  const fourth = isStudent
    ? metricCard("My room", user.buildingId ? `${buildingName(user.buildingId).replace(" Hall", "")} ${user.room || ""}` : "Not set", user.buildingId ? "From your housing details" : "Add it in My account")
    : readiness.beds
      ? metricCard("Beds occupied", `${Math.round((readiness.occupied / readiness.beds) * 100)}%`, `${readiness.occupied} of ${readiness.beds} modeled beds · ${readiness.halls} halls`)
      : canSeePeople()
        ? metricCard("Pending invitations", String(state.invitations.filter((item) => item.status === "pending").length), "Waiting to be accepted")
        : metricCard("Buildings in scope", String(buildings.filter((building) => canViewFloorPlan(user, building)).length), "With modeled floor plans");

  pageRoot.innerHTML = `
    <div class="view">
      ${renderHero()}
      <section class="metrics-grid" aria-label="Operational metrics">
        ${metricCard(isStudent ? "My open requests" : "Open work", String(metrics.open), r.aggregateOnly ? "Approved aggregate count" : "Within your scope")}
        ${metricCard("Urgent", String(metrics.urgent), metrics.urgent ? "Needs attention today" : "Nothing urgent in scope")}
        ${metricCard("Overdue", String(metrics.overdue), metrics.overdue ? "Review ownership and blockers" : "Nothing overdue", metrics.overdue === 0)}
        ${fourth}
      </section>
      <section class="content-grid">
        <article class="panel">
          <div class="panel-header">
            <div><h2 class="section-title">${r.aggregateOnly ? "Department pulse" : isStudent ? "My requests" : "Work needing attention"}</h2><p class="panel-subtitle">${r.aggregateOnly ? "Counts only; restricted units are combined" : "Only records your role can see"}</p></div>
            ${canCreateWorkOrder(user) ? `<button class="button primary" data-action="create-order">+ New request</button>` : ""}
          </div>
          ${r.aggregateOnly ? summaryTable() : ordersTable(filteredOrders(), 6)}
        </article>
        <aside class="panel">
          <div class="panel-header"><div><h2 class="section-title">Recent activity</h2><p class="panel-subtitle">From the audit log in your scope</p></div></div>
          <ul class="activity-list">
            ${state.auditEvents.length ? state.auditEvents.slice(0, 5).map((event) => `<li class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(event.action)} · ${escapeHtml(event.target)}</strong><span>${escapeHtml(event.actor)}${event.detail ? ` — ${escapeHtml(event.detail)}` : ""}</span><time>${relativeAge(event.at)}</time></div></li>`).join("") : `<li class="empty-state">Activity history isn't part of this role.</li>`}
          </ul>
        </aside>
      </section>
    </div>`;
}

function renderWorkOrders() {
  const user = me();
  const r = role();
  const orders = filteredOrders();
  const filters = [["open", "Open"], ["urgent", "Urgent"], ["unassigned", "Unassigned"], ["completed", "Closed"], ["all", "All"]];
  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading">
        <div><span class="eyebrow">Service coordination</span><h1>Work order center</h1><p>The database decides which records reach you, based on role, department, halls, sensitivity, assignment, and ownership.</p></div>
        ${canCreateWorkOrder(user) ? `<button class="button primary" data-action="create-order">+ New request</button>` : ""}
      </header>
      ${r.aggregateOnly ? `
        <section class="panel">
          <div class="notice"><strong>Aggregate access</strong>${escapeHtml(r.label)} sees operating totals, not the contents of individual requests.</div>
          ${summaryTable()}
        </section>` : `
        <section class="panel">
          <div class="panel-header">
            <div class="filter-row" aria-label="Work order filters">${filters.map(([value, label]) => `<button class="filter-chip ${state.orderFilter === value ? "is-active" : ""}" data-filter="${value}" aria-pressed="${state.orderFilter === value}">${label}</button>`).join("")}</div>
            <span class="panel-subtitle">${orders.length} shown</span>
          </div>
          ${ordersTable(orders)}
        </section>`}
    </div>`;
}

/* ---------- Campus map ---------- */

function openWorkByBuilding() {
  const counts = new Map();
  for (const order of state.workOrders) {
    if (isOpen(order)) counts.set(order.buildingId, (counts.get(order.buildingId) || 0) + 1);
  }
  return counts;
}

function matchesMapFilter(building) {
  const query = state.mapQuery.trim().toLowerCase();
  const typeOk = state.mapFilter === "all" || building.type === state.mapFilter;
  const queryOk = !query || building.name.toLowerCase().includes(query) || String(building.mapNo) === query;
  return typeOk && queryOk;
}

function renderCampusSvg(selected, workCounts) {
  const streets = campusStreets
    .map((street) => {
      const points = street.points.map(([x, y]) => `${x},${y}`).join(" ");
      const [[x1, y1], [x2, y2]] = street.points;
      const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
      const label = `<text class="street-label" x="${(x1 + x2) / 2 + (vertical ? 12 : 0)}" y="${(y1 + y2) / 2 - (vertical ? 0 : 9)}" ${vertical ? `transform="rotate(90 ${(x1 + x2) / 2 + 12} ${(y1 + y2) / 2})"` : ""}>${escapeHtml(street.name)}</text>`;
      return `<polyline class="street" points="${points}"/>${label}`;
    })
    .join("");

  const trees = [[150,160],[260,230],[380,120],[510,220],[690,130],[810,260],[990,170],[1120,100],[1260,230],[1520,360],[1460,740],[1320,880],[1170,1060],[980,1160],[740,1080],[550,1180],[320,1040],[160,870],[260,660],[470,760],[710,620],[940,720],[1140,580],[1540,1030]]
    .map(([x, y], index) => `<g class="campus-tree" transform="translate(${x} ${y})"><ellipse cx="${index % 2 ? 6 : -6}" cy="0" rx="14" ry="10"/><ellipse cx="0" cy="-8" rx="12" ry="15"/><circle cx="0" cy="0" r="4"/></g>`).join("");

  const markers = buildings
    .map((building) => {
      const dim = !matchesMapFilter(building);
      const isSelected = building.id === selected.id;
      const work = workCounts.get(building.id) || 0;
      const floors = Math.max(1, Math.min(5, building.floors || 1));
      const width = building.type === "athletics" ? 56 : building.type === "residence" ? 43 : 36;
      const height = building.type === "athletics" ? 35 : 27;
      const rise = 8 + floors * 4;
      return `
        <g class="map-marker type-${building.type} ${isSelected ? "is-selected" : ""} ${dim ? "is-dim" : ""} ${building.offline ? "is-offline" : ""}"
           data-building-id="${building.id}" tabindex="${dim ? -1 : 0}" role="button"
           aria-label="${escapeHtml(`${building.mapNo}. ${building.name}${work ? `, ${work} open work orders in your scope` : ""}`)}" aria-pressed="${isSelected}">
          <title>${escapeHtml(`${building.mapNo}. ${building.name}`)}</title>
          ${isSelected ? `<ellipse class="selection-halo" cx="${building.x}" cy="${building.y + 9}" rx="${width * .78}" ry="${height * .9}"/>` : ""}
          <g class="building-mass" transform="translate(${building.x} ${building.y})">
            <polygon class="building-front" points="${-width / 2},${-height / 2} ${width / 2},${-height / 2} ${width / 2},${height / 2} ${-width / 2},${height / 2}"/>
            <polygon class="building-roof" points="${-width / 2},${-height / 2} ${-width / 2 + rise},${-height / 2 - rise} ${width / 2 + rise},${-height / 2 - rise} ${width / 2},${-height / 2}"/>
            <polygon class="building-side" points="${width / 2},${-height / 2} ${width / 2 + rise},${-height / 2 - rise} ${width / 2 + rise},${height / 2 - rise} ${width / 2},${height / 2}"/>
          </g>
          <circle class="map-number" cx="${building.x}" cy="${building.y}" r="14"/>
          <text x="${building.x}" y="${building.y + 5}">${building.mapNo}</text>
          ${work ? `<circle class="work-dot" cx="${building.x + width / 2 + 7}" cy="${building.y - height / 2 - rise}" r="12"/><text class="work-count" x="${building.x + width / 2 + 7}" y="${building.y - height / 2 - rise + 4}">${work}</text>` : ""}
        </g>`;
    })
    .join("");

  const start = state.userMapPoint || { x: 118, y: 1160, label: "Campus entrance" };
  const route = state.routeActive ? `<g class="campus-route"><polyline points="${start.x},${start.y} ${Math.round((start.x + selected.x) / 2)},${start.y} ${Math.round((start.x + selected.x) / 2)},${selected.y} ${selected.x},${selected.y}"/><circle class="route-start" cx="${start.x}" cy="${start.y}" r="12"/><text x="${start.x + 18}" y="${start.y - 12}">${escapeHtml(start.label || "You")}</text><circle class="route-end" cx="${selected.x}" cy="${selected.y}" r="9"/></g>` : "";

  const userPoint = state.userMapPoint ? `<g class="user-map-point"><circle cx="${state.userMapPoint.x}" cy="${state.userMapPoint.y}" r="22"/><circle cx="${state.userMapPoint.x}" cy="${state.userMapPoint.y}" r="7"/><text x="${state.userMapPoint.x + 28}" y="${state.userMapPoint.y + 5}">You</text></g>` : "";

  return `<svg class="campus-svg mode-${state.mapMode}" viewBox="30 30 1580 1220" role="group" aria-label="Grambling State University digital twin with ${buildings.length} numbered buildings">
      <rect class="campus-ground" x="30" y="30" width="1580" height="1220" rx="18"/>
      <path class="campus-water" d="M90 780 C210 720 290 760 330 850 C360 930 250 990 135 950 C70 925 50 835 90 780Z"/>
      ${trees}
      ${streets}
      ${route}
      ${markers}
      ${userPoint}
    </svg>`;
}

function renderBuildingDetails(building) {
  const work = state.workOrders.filter((order) => order.buildingId === building.id && isOpen(order));
  const canPlan = canViewFloorPlan(me(), building);
  const facts = [
    ["Map number", String(building.mapNo)],
    ["Type", buildingTypes[building.type]],
    ["Floors", building.floors ? String(building.floors) : "Not modeled"],
    ["Open work in your scope", String(work.length)]
  ];
  if (building.type === "residence") {
    facts.push(["Capacity", building.capacity ? `${building.capacity} residents` : "Not published"]);
    facts.push(["Layout", titleCase(building.layout || "traditional")]);
  }
  const planAction = !building.floors
    ? `<div class="notice"><strong>Location only</strong>No room-level model has been built for this site yet.</div>`
    : canPlan
      ? `<button class="button primary" data-action="open-floors" data-building-id="${building.id}">Open floor plans →</button>`
      : `<div class="notice"><strong>Floor plan restricted</strong>Your role can see the public location but not the room-level layer.</div>`;
  const routeLength = Math.hypot((state.userMapPoint?.x || 118) - building.x, (state.userMapPoint?.y || 1160) - building.y);
  const walkMinutes = Math.max(2, Math.round(routeLength / 115));

  return `
    <div class="building-card">
      <div>
        <span class="eyebrow">${escapeHtml(building.hall || buildingTypes[building.type])}${building.gender ? ` · ${escapeHtml(building.gender)}` : ""}</span>
        <h2>${escapeHtml(building.name)}</h2>
        ${building.offline ? `<p>${badge("blocked", "Listed offline by Campus Living")}</p>` : ""}
      </div>
      <div class="building-meta">${facts.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
      <div class="route-card ${state.routeActive ? "is-active" : ""}">
        <div><span>${state.userMapPoint ? "From your GPS position" : "From the south campus entrance"}</span><strong>${walkMinutes} min estimated walk</strong><small>Prototype route follows the official map geometry.</small></div>
        <button class="button secondary" type="button" data-action="start-route">${state.routeActive ? "Route active" : "Start route"}</button>
      </div>
      ${building.capacityNote ? `<p class="panel-subtitle">${escapeHtml(building.capacityNote)}</p>` : ""}
      ${planAction}
      ${work.length ? `<div><h3 class="section-title">Open work here</h3>${compactOrders(work)}</div>` : ""}
    </div>`;
}

function renderMap() {
  const selected = getBuilding(state.selectedBuildingId) || buildings[0];
  const workCounts = openWorkByBuilding();
  const types = [["all", "All"], ...Object.entries(buildingTypes)];
  const listed = buildings.filter(matchesMapFilter);

  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading"><div><span class="eyebrow">Interactive campus digital twin</span><h1>Campus navigator</h1><p>Search, speak a destination, or use GPS to route across a dimensional view grounded in the official GSU campus map. Gold badges count open work your role can see.</p></div><div class="map-view-actions"><button class="button secondary" type="button" data-action="locate-me">Use my GPS</button><div class="segmented-control" aria-label="Map view"><button type="button" data-map-mode="2d" class="${state.mapMode === "2d" ? "is-active" : ""}" aria-pressed="${state.mapMode === "2d"}">2D</button><button type="button" data-map-mode="3d" class="${state.mapMode === "3d" ? "is-active" : ""}" aria-pressed="${state.mapMode === "3d"}">3D</button></div></div></header>
      ${state.locationMessage ? `<div class="location-status">${escapeHtml(state.locationMessage)}</div>` : ""}
      <section class="panel map-toolbar">
        <div class="filter-row" aria-label="Building type filter">${types.map(([value, label]) => `<button class="filter-chip type-chip type-${value} ${state.mapFilter === value ? "is-active" : ""}" data-map-filter="${value}" aria-pressed="${state.mapFilter === value}">${escapeHtml(label)}</button>`).join("")}</div>
        <label class="search-field"><span class="sr-only">Search buildings</span><input type="search" id="map-search" placeholder="Search building or map #" value="${escapeHtml(state.mapQuery)}" /></label>
      </section>
      <section class="map-layout">
        <div class="campus-map"><div class="map-compass" aria-hidden="true"><span>N</span></div>${renderCampusSvg(selected, workCounts)}<div class="map-legend"><span><i class="legend-route"></i>Walking route</span><span><i class="legend-work"></i>Open work</span></div></div>
        <aside class="panel" id="building-details">${renderBuildingDetails(selected)}</aside>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2 class="section-title">Building list</h2><p class="panel-subtitle">Text alternative to the map · ${listed.length} shown</p></div></div>
        <ul class="building-list">${listed.map((building) => `<li><button class="building-row ${building.id === selected.id ? "is-selected" : ""}" data-building-id="${building.id}"><span class="map-no type-${building.type}">${building.mapNo}</span><span><strong>${escapeHtml(building.name)}</strong><small>${escapeHtml(buildingTypes[building.type])}${building.floors ? ` · ${building.floors} fl` : ""}${workCounts.get(building.id) ? ` · ${workCounts.get(building.id)} open` : ""}</small></span></button></li>`).join("")}</ul>
      </section>
    </div>`;
}

/* ---------- Floor plans ---------- */

function spaceWork(buildingId, spaceId) {
  return state.workOrders.filter((order) => order.buildingId === buildingId && order.room === spaceId && isOpen(order));
}

function occupancyClass(room) {
  if (!room) return "";
  if (room.occupied === 0) return "occ-vacant";
  if (room.occupied < room.beds) return "occ-partial";
  return "occ-full";
}

function renderPlanSvg(plan, building, layers) {
  const user = me();
  const groups = plan.spaces
    .map((space) => {
      const room = roomState(building.id, space);
      const work = layers.work ? spaceWork(building.id, space.id) : [];
      const urgent = work.some((order) => order.priority !== "routine");
      const mine = user.buildingId === building.id && user.room === space.id;
      const classes = [
        "fp-space", `kind-${space.kind}`,
        layers.occupancy ? occupancyClass(room) : "",
        layers.occupancy && room?.readiness !== "ready" ? `ready-${room?.readiness}` : "",
        work.length ? "has-work" : "", mine ? "is-mine" : "",
        state.selectedSpaceId === space.id ? "is-selected" : ""
      ].filter(Boolean).join(" ");
      const interior = space.kind === "unit"
        ? Array.from({ length: space.bedrooms }, (_, index) => {
            const w = space.w / space.bedrooms;
            return `<rect class="fp-bedroom" x="${space.x + index * w}" y="${space.y}" width="${w}" height="${space.h * 0.42}"/><text class="fp-bed-label" x="${space.x + index * w + w / 2}" y="${space.y + space.h * 0.26}">${String.fromCharCode(65 + index)}</text>`;
          }).join("")
        : "";
      const description = [space.label, room && layers.occupancy ? `${room.occupied} of ${room.beds} beds occupied, ${room.readiness}` : "", work.length ? `${work.length} open work order${work.length > 1 ? "s" : ""}` : "", mine ? "your room" : ""].filter(Boolean).join(", ");
      const labelY = space.kind === "unit" ? space.y + space.h * 0.72 : space.y + space.h / 2 + 4;
      return `
        <g class="${classes}" data-space-id="${escapeHtml(space.id)}" tabindex="0" role="button" aria-label="${escapeHtml(description)}">
          <rect x="${space.x}" y="${space.y}" width="${space.w}" height="${space.h}"/>
          ${interior}
          ${space.w >= 30 ? `<text x="${space.x + space.w / 2}" y="${labelY}">${escapeHtml(space.label)}</text>` : ""}
          ${work.length ? `<circle class="fp-pin ${urgent ? "urgent" : ""}" cx="${space.x + space.w - 10}" cy="${space.y + 10}" r="8"/><text class="fp-pin-label" x="${space.x + space.w - 10}" y="${space.y + 14}">${work.length}</text>` : ""}
          ${mine ? `<text class="fp-mine" x="${space.x + space.w / 2}" y="${space.y + space.h - 8}">YOU</text>` : ""}
        </g>`;
    })
    .join("");
  return `<svg class="floor-svg" viewBox="0 0 ${plan.width} ${plan.height}" role="group" aria-label="${escapeHtml(`${building.name} floor ${plan.floor}, modeled plan`)}">${groups}</svg>`;
}

function renderPlanTable(plan, building, layers) {
  const rows = plan.spaces
    .filter((space) => isBookableSpace(space) || spaceWork(building.id, space.id).length)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((space) => {
      const room = roomState(building.id, space);
      const work = layers.work ? spaceWork(building.id, space.id) : [];
      return `<tr data-space-id="${escapeHtml(space.id)}" tabindex="0"><td><strong>${escapeHtml(space.id)}</strong></td><td>${escapeHtml(titleCase(space.kind))}${space.bedrooms ? ` · ${space.bedrooms} BR` : ""}</td>${layers.occupancy ? `<td>${room ? `${room.occupied}/${room.beds}` : "—"}</td><td>${room ? badge(room.readiness) : "—"}</td>` : ""}<td>${work.length ? work.map((order) => escapeHtml(order.ref)).join(", ") : "—"}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Space</th><th>Type</th>${layers.occupancy ? "<th>Occupied</th><th>Readiness</th>" : ""}<th>Open work</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function creatableBuildings() {
  const user = me();
  const r = role();
  if (r.scopeMode === "own" && user.buildingId) return buildings.filter((building) => building.id === user.buildingId);
  return buildings.filter((building) => !r.buildingScoped || isBuildingInScope(user, building.id));
}

function renderSpaceDetails(building, plan, layers) {
  const space = plan.spaces.find((item) => item.id === state.selectedSpaceId);
  if (!space) return `<div class="empty-state">Select a room, unit, or common space to see its details and any work you're allowed to see.</div>`;
  const room = roomState(building.id, space);
  const work = spaceWork(building.id, space.id);
  const canReport = canCreateWorkOrder(me()) && creatableBuildings().includes(building);
  return `
    <div class="building-card">
      <div><span class="eyebrow">${escapeHtml(building.name)} · Floor ${plan.floor}</span><h2>${escapeHtml(space.label === space.id ? `Room ${space.id}` : space.label)}</h2><p class="panel-subtitle">${escapeHtml(titleCase(space.kind))}${space.bedrooms ? ` · ${space.bedrooms}-bedroom apartment` : ""}</p></div>
      <div class="building-meta">
        ${room && layers.occupancy ? `<div><span>Occupancy</span><strong>${room.occupied} / ${room.beds} beds</strong></div><div><span>Readiness</span><strong>${escapeHtml(titleCase(room.readiness))}</strong></div>` : ""}
        <div><span>Open work visible</span><strong>${work.length}</strong></div>
        <div><span>Space ID</span><strong>${escapeHtml(space.id)}</strong></div>
      </div>
      ${room && !layers.occupancy ? `<p class="panel-subtitle">Occupancy is hidden for your role.</p>` : ""}
      ${work.length ? compactOrders(work) : ""}
      ${canReport ? `<button class="button primary" data-action="create-order" data-building-id="${building.id}" data-room="${escapeHtml(space.id)}">Report an issue here</button>` : ""}
    </div>`;
}

function renderFloors() {
  const user = me();
  const available = buildings.filter((building) => canViewFloorPlan(user, building));
  if (!available.length) {
    pageRoot.innerHTML = `<div class="view"><header class="page-heading"><div><span class="eyebrow">Room-level layer</span><h1>Floor plans</h1></div></header><section class="panel"><div class="notice"><strong>No floor plans in your scope</strong>${user.role === "student" ? "Floor plans appear once your residence hall is on file." : `${escapeHtml(role().label)} works from aggregates and public building locations.`}</div></section></div>`;
    return;
  }
  if (!available.some((building) => building.id === state.selectedBuildingId)) {
    state.selectedBuildingId = (available.find((building) => building.id === user.buildingId) || available[0]).id;
    state.selectedSpaceId = null;
  }
  const building = getBuilding(state.selectedBuildingId);
  state.selectedFloor = Math.min(Math.max(1, state.selectedFloor), building.floors);
  const plan = generateFloorPlan(building, state.selectedFloor);
  const occupancyAllowed = canViewOccupancy(user, building);
  const layers = { occupancy: occupancyAllowed && state.showOccupancy, work: state.showWork };
  const groups = Object.entries(buildingTypes)
    .map(([type, label]) => {
      const options = available.filter((item) => item.type === type);
      return options.length ? `<optgroup label="${escapeHtml(label)}">${options.map((item) => `<option value="${item.id}" ${item.id === building.id ? "selected" : ""}>${item.mapNo}. ${escapeHtml(item.name)}</option>`).join("")}</optgroup>` : "";
    })
    .join("");

  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading">
        <div><span class="eyebrow">Room-level layer · modeled</span><h1>Floor plans</h1><p>Generated from published capacity and layout type. Not construction drawings; replace with approved CAD/PDF plans before operational use.</p></div>
      </header>
      <section class="panel plan-toolbar">
        <label class="inline-field">Building <select id="plan-building">${groups}</select></label>
        <div class="filter-row" role="group" aria-label="Floor">${Array.from({ length: building.floors }, (_, index) => index + 1).map((floor) => `<button class="filter-chip ${floor === plan.floor ? "is-active" : ""}" data-floor="${floor}" aria-pressed="${floor === plan.floor}">Floor ${floor}</button>`).join("")}</div>
        <div class="filter-row" role="group" aria-label="Layers">
          <label class="toggle"><input type="checkbox" data-layer="work" ${state.showWork ? "checked" : ""}/> Work orders</label>
          <label class="toggle ${occupancyAllowed ? "" : "is-disabled"}"><input type="checkbox" data-layer="occupancy" ${layers.occupancy ? "checked" : ""} ${occupancyAllowed ? "" : "disabled"}/> Occupancy${occupancyAllowed ? "" : " (restricted)"}</label>
          <label class="toggle"><input type="checkbox" data-layer="table" ${state.planAsTable ? "checked" : ""}/> Text view</label>
        </div>
      </section>
      <section class="map-layout">
        <div class="panel plan-canvas">
          ${state.planAsTable ? renderPlanTable(plan, building, layers) : renderPlanSvg(plan, building, layers)}
          <div class="plan-legend" aria-label="Legend">
            ${layers.occupancy ? `<span><i class="swatch occ-full"></i>Full</span><span><i class="swatch occ-partial"></i>Partial</span><span><i class="swatch occ-vacant"></i>Vacant</span><span><i class="swatch ready-inspection"></i>Inspection / turnover</span>` : ""}
            ${layers.work ? `<span><i class="swatch pin"></i>Open work (your scope)</span><span><i class="swatch pin urgent"></i>Urgent</span>` : ""}
            <span><i class="swatch common"></i>Common / service</span>
          </div>
        </div>
        <aside class="panel" id="space-details">${renderSpaceDetails(building, plan, layers)}</aside>
      </section>
    </div>`;
}

/* ---------- Organization ---------- */

function orgTree(parentId, scopeIds) {
  const children = organization.filter((unit) => unit.parentId === parentId);
  if (!children.length) return "";
  return `<ul>${children.map((unit) => `<li><div class="org-node ${scopeIds.has(unit.id) ? "in-scope" : ""} ${unit.sensitive ? "is-sensitive" : ""}"><div><strong>${escapeHtml(unit.name)}</strong><span>${escapeHtml(titleCase(unit.kind))}</span></div><span class="tag-group">${unit.sensitive ? `<span class="source-tag restricted">Restricted</span>` : ""}<span class="source-tag">${unit.source === "public" ? "Public structure" : "Pilot model"}</span></span></div>${orgTree(unit.id, scopeIds)}</li>`).join("")}</ul>`;
}

// Template-level reference: each cell runs the shared policy code against a sample record.
function accessMatrix() {
  const sample = {
    housing: { orgId: "housing-maintenance", buildingId: "mildred-jones", requesterId: "u-student", assigneeId: "u-tech" },
    holland: { orgId: "housing-maintenance", buildingId: "holland", requesterId: "u-student-2", assigneeId: null },
    it: { orgId: "it-help-desk", buildingId: "jacob-stewart", requesterId: "u-faculty-1", assigneeId: null },
    health: { orgId: "health-center", buildingId: "foster-johnson", requesterId: "u-health", assigneeId: null }
  };
  const probes = [
    ["Housing work order", "work_order:view", sample.housing],
    ["Assign housing work", "work_order:assign", sample.housing],
    ["Holland Hall work", "work_order:view", sample.holland],
    ["IT ticket", "work_order:view", sample.it],
    ["Health Center work", "work_order:view", sample.health],
    ["Jones Hall plan", "floorplan:view", getBuilding("mildred-jones")],
    ["Jones occupancy", "occupancy:view", getBuilding("mildred-jones")]
  ];
  const rows = personas.map((persona) => {
    const cells = probes.map(([label, action, resource]) => {
      const { allowed } = permissionDecision(persona, action, resource);
      return `<td class="${allowed ? "cell-allow" : "cell-deny"}"><span aria-hidden="true">${allowed ? "✓" : "—"}</span><span class="sr-only">${allowed ? "Allowed" : "Denied"}: ${escapeHtml(label)}</span></td>`;
    }).join("");
    return `<tr class="${persona.role === me().role ? "is-current" : ""}"><th scope="row">${escapeHtml(roleTemplates[persona.role].label)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="matrix"><thead><tr><th scope="col">Role</th>${probes.map(([label]) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderOrganization() {
  const user = me();
  const r = role();
  const scopeIds = new Set(getScopedOrgIds(user));
  const root = organization.find((unit) => unit.id === "university");
  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading"><div><span class="eyebrow">Hierarchical RBAC + resource scope</span><h1>Organization and access</h1><p>Roles grant actions; the department tree, halls, ownership, and sensitivity decide which records those actions reach.</p></div></header>
      <section class="org-layout">
        <article class="panel">
          <div class="panel-header"><div><h2 class="section-title">Grambling pilot structure</h2><p class="panel-subtitle">Gold shows your reach. Restricted units don't inherit from their parent.</p></div></div>
          <ul class="org-tree"><li><div class="org-node ${scopeIds.has(root.id) ? "in-scope" : ""}"><div><strong>${escapeHtml(root.name)}</strong><span>Institution</span></div><span class="source-tag">Public structure</span></div>${orgTree(root.id, scopeIds)}</li></ul>
        </article>
        <aside class="panel">
          <span class="eyebrow">Your policy bundle</span>
          <h2 class="section-title">${escapeHtml(r.label)}</h2>
          <p>${escapeHtml(r.explanation)}</p>
          <div class="building-meta"><div><span>Access level</span><strong>${escapeHtml(r.level)}</strong></div><div><span>Resource scope</span><strong>${escapeHtml(roleScopeLabel())}</strong></div></div>
          ${r.buildingScoped ? `<h3>Halls</h3><ul class="permission-list">${user.buildingIds.map((id) => `<li>${escapeHtml(buildingName(id))}</li>`).join("")}</ul>` : ""}
          <h3>Enabled features</h3>
          <ul class="permission-list">${r.permissions.map((permission) => `<li>${escapeHtml(featureLabels[permission] || permission)}</li>`).join("")}</ul>
          <h3>Decision path</h3>
          <div class="policy-flow"><div class="policy-step"><strong>1. Identity</strong><br>Signed-in profile</div><div class="policy-step"><strong>2. Role</strong><br>Feature enabled?</div><div class="policy-step"><strong>3. Scope</strong><br>Dept, hall, sensitivity</div><div class="policy-step"><strong>4. Audit</strong><br>Change recorded</div></div>
        </aside>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2 class="section-title">Role reference matrix</h2><p class="panel-subtitle">Each cell runs the shared policy code against a sample record for the default version of each role. Your role is highlighted.</p></div></div>
        ${accessMatrix()}
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2 class="section-title">Research behind the model</h2><p class="panel-subtitle">Public facts kept separate from pilot assumptions</p></div></div>
        <ul class="plain-list">${researchNotes.map((note) => `<li class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(note)}</strong></div></li>`).join("")}</ul>
      </section>
    </div>`;
}

/* ---------- People and invitations ---------- */

function personScope(person) {
  if (person.buildingIds?.length) return person.buildingIds.map(buildingName).join(", ");
  if (person.orgId) return orgName(person.orgId);
  if (person.buildingId) return `${buildingName(person.buildingId)}${person.room ? ` · ${person.room}` : ""}`;
  return "Student";
}

function statusBadge(status, expiresAt) {
  if (status === "active" && expiresAt && daysUntil(expiresAt) <= 14) return badge("inspection", "Expiring soon");
  const map = { active: ["completed", "Active"], pending_verification: ["triage", "Unverified"], suspended: ["blocked", "Suspended"], expired: ["blocked", "Expired"], pending: ["assigned", "Pending"], accepted: ["completed", "Accepted"], revoked: ["blocked", "Revoked"] };
  const [kind, label] = map[status] || ["triage", titleCase(status)];
  return badge(kind, label);
}

function filteredPeople() {
  const query = state.peopleQuery.trim().toLowerCase();
  return state.people.filter((person) => {
    if (query && !`${person.name} ${person.email} ${person.roleLabel}`.toLowerCase().includes(query)) return false;
    if (state.peopleFilter === "staff") return person.role !== "student";
    if (state.peopleFilter === "students") return person.role === "student";
    if (state.peopleFilter === "expiring") return person.accessExpiresAt && daysUntil(person.accessExpiresAt) <= 30;
    if (state.peopleFilter === "inactive") return person.status !== "active";
    return true;
  });
}

function personActions(person) {
  if (!person.canManage) return `<span class="panel-subtitle">—</span>`;
  const template = roleTemplates[person.role];
  const actions = [];
  if (person.status === "suspended") actions.push(["reactivate", "Reactivate"]);
  else if (person.status === "active") actions.push(["suspend", "Suspend"]);
  actions.push(["extend-30", "+30 days"]);
  if (!template?.maxAccessDays || template.maxAccessDays >= 90) actions.push(["extend-90", "+90 days"]);
  if (person.status !== "expired") actions.push(["end_access", "End access"]);
  actions.push(["features", "Features…"]);
  return `<div class="row-actions">${actions.map(([action, label]) => `<button type="button" class="mini-button ${action === "end_access" || action === "suspend" ? "danger" : ""}" data-person-action="${action}" data-person-id="${escapeHtml(person.id)}">${label}</button>`).join("")}</div>`;
}

function renderPeopleTable() {
  const people = filteredPeople();
  const filters = [["all", "All"], ["staff", "Staff"], ["students", "Students"], ["expiring", "Ending ≤ 30 days"], ["inactive", "Inactive"]];
  return `
    <div class="panel-header">
      <div class="filter-row">${filters.map(([value, label]) => `<button class="filter-chip ${state.peopleFilter === value ? "is-active" : ""}" data-people-filter="${value}" aria-pressed="${state.peopleFilter === value}">${label}</button>`).join("")}</div>
      <label class="search-field"><span class="sr-only">Search people</span><input type="search" id="people-search" placeholder="Search name, email, role" value="${escapeHtml(state.peopleQuery)}" /></label>
    </div>
    <div class="table-wrap"><table class="people-table"><thead><tr><th>Person</th><th>Role</th><th>Scope</th><th>Status</th><th>Access</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>
      ${people.length ? people.map((person) => `
        <tr>
          <td><span class="assignee-cell"><span class="avatar">${escapeHtml(initials(person.name))}</span><span><strong>${escapeHtml(person.name)}</strong><br><span class="ticket-id">${escapeHtml(person.email)}</span></span></span></td>
          <td>${escapeHtml(person.roleLabel)}${person.invitedByName ? `<br><span class="ticket-id">Invited by ${escapeHtml(person.invitedByName)}</span>` : ""}</td>
          <td>${escapeHtml(personScope(person))}</td>
          <td>${statusBadge(person.status, person.accessExpiresAt)}</td>
          <td>${escapeHtml(accessLabel(person.accessExpiresAt))}</td>
          <td>${person.lastSignInAt ? relativeAge(person.lastSignInAt) : "Never"}</td>
          <td>${personActions(person)}</td>
        </tr>`).join("") : `<tr><td colspan="7"><div class="empty-state">No people match.</div></td></tr>`}
    </tbody></table></div>`;
}

function renderInvitationsTable() {
  const invitations = state.invitations;
  return `
    <div class="table-wrap"><table><thead><tr><th>Invitee</th><th>Role</th><th>Scope</th><th>Access length</th><th>Status</th><th>Sent by</th><th>Link expires</th><th>Actions</th></tr></thead><tbody>
      ${invitations.length ? invitations.map((invite) => `
        <tr>
          <td><strong>${escapeHtml(invite.name || invite.email)}</strong>${invite.name ? `<br><span class="ticket-id">${escapeHtml(invite.email)}</span>` : ""}</td>
          <td>${escapeHtml(invite.roleLabel)}</td>
          <td>${escapeHtml(invite.buildingIds.length ? invite.buildingIds.map(buildingName).join(", ") : orgName(invite.orgId))}</td>
          <td>${invite.accessDays ? `${invite.accessDays} days` : "No end date"}</td>
          <td>${statusBadge(invite.status)}</td>
          <td>${escapeHtml(invite.invitedByName)}<br><span class="ticket-id">${relativeAge(invite.createdAt)}</span></td>
          <td>${invite.status === "pending" ? formatDate(invite.expiresAt) : invite.acceptedAt ? `Accepted ${relativeAge(invite.acceptedAt)}` : "—"}</td>
          <td>${invite.canManage && ["pending", "expired"].includes(invite.status) ? `<div class="row-actions"><button type="button" class="mini-button" data-invite-action="resend" data-invite-id="${escapeHtml(invite.id)}">Resend</button>${invite.status === "pending" ? `<button type="button" class="mini-button danger" data-invite-action="revoke" data-invite-id="${escapeHtml(invite.id)}">Revoke</button>` : ""}</div>` : "—"}</td>
        </tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">No invitations yet.</div></td></tr>`}
    </tbody></table></div>`;
}

function renderPeople() {
  const user = me();
  const canInvite = hasPermission(user, "people:invite") && user.canInvite?.length;
  const tabs = [["people", `People (${state.people.length})`], ["invitations", `Invitations (${state.invitations.filter((item) => item.status === "pending").length} pending)`]];
  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading">
        <div><span class="eyebrow">Identity and access</span><h1>People and invitations</h1><p>Invite people into roles you're allowed to grant, for the halls and time window you choose. Everyone listed here is inside your scope.</p></div>
        ${canInvite ? `<button class="button primary" data-action="invite">+ Invite someone</button>` : ""}
      </header>
      <section class="panel">
        <div class="tab-row" role="tablist">${tabs.map(([value, label]) => `<button role="tab" class="tab ${state.peopleTab === value ? "is-active" : ""}" aria-selected="${state.peopleTab === value}" data-people-tab="${value}">${escapeHtml(label)}</button>`).join("")}</div>
        ${state.peopleTab === "people" ? renderPeopleTable() : renderInvitationsTable()}
      </section>
      ${canInvite ? `<section class="panel"><div class="panel-header"><div><h2 class="section-title">Roles you can grant</h2><p class="panel-subtitle">You can't grant a role, department, hall, or feature outside your own reach.</p></div></div><ul class="role-grid">${user.canInvite.map((key) => { const t = roleTemplates[key]; return `<li><strong>${escapeHtml(t.label)}</strong><span>${escapeHtml(t.level)}${t.maxAccessDays ? ` · max ${t.maxAccessDays} days` : ""}</span><p>${escapeHtml(t.explanation)}</p></li>`; }).join("")}</ul></section>` : ""}
    </div>`;
}

// Departments the invitee could belong to: inside my reach, and inside the role's own reach.
function invitableOrgs(roleKey) {
  const template = roleTemplates[roleKey];
  const mine = new Set(getDescendantIds(role().scopeOrgId));
  const allowed = template.scopeMode === "subtree" ? new Set(getDescendantIds(template.scopeOrgId)) : null;
  return organization.filter((unit) => mine.has(unit.id) && (!allowed || allowed.has(unit.id)));
}

function invitableHalls() {
  const r = role();
  return buildings.filter((building) => building.type === "residence" && !building.offline && (!r.buildingScoped || me().buildingIds.includes(building.id)));
}

function defaultDraft(roleKey = me().canInvite[0]) {
  const template = roleTemplates[roleKey];
  const orgs = invitableOrgs(roleKey);
  return {
    email: "",
    fullName: "",
    role: roleKey,
    orgId: orgs.find((unit) => unit.id === template.scopeOrgId)?.id || orgs.find((unit) => unit.id === me().orgId)?.id || orgs[0]?.id || "",
    buildingIds: role().buildingScoped ? me().buildingIds.slice(0, 1) : [],
    accessDays: template.maxAccessDays ? String(template.maxAccessDays) : "",
    validHours: "72",
    permissions: [...template.permissions],
    note: "",
    error: "",
    result: null,
    busy: false
  };
}

function renderInviteDialog() {
  const draft = state.inviteDraft;
  if (draft.result) {
    return `
      <div class="dialog-header"><div><span class="eyebrow">Invitation sent</span><h2 id="work-order-dialog-title">${escapeHtml(draft.email)}</h2></div><button class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>
      <div class="dialog-body">
        <p>They'll get an email with this link. It expires ${escapeHtml(formatDate(draft.result.expiresAt))}. You can also share it directly; it only works for ${escapeHtml(draft.email)}.</p>
        <label class="link-box">Invitation link<input readonly value="${escapeHtml(draft.result.link)}" id="invite-link" /></label>
        <div class="dialog-actions inline">
          <button type="button" class="button secondary" data-invite-ui="copy">Copy link</button>
          ${state.demo ? `<a class="button secondary" href="/?mailbox" target="_blank" rel="noopener">Open dev mailbox</a>` : ""}
          <button type="button" class="button primary" data-invite-ui="another">Invite another person</button>
        </div>
      </div>`;
  }
  const template = roleTemplates[draft.role];
  const orgs = invitableOrgs(draft.role);
  const durations = [["", "No end date"], ["7", "7 days"], ["30", "30 days"], ["60", "60 days"], ["90", "90 days"], ["180", "180 days"], ["365", "1 year"]]
    .filter(([value]) => (template.maxAccessDays ? value && Number(value) <= template.maxAccessDays : true));
  return `
    <form id="invite-form" novalidate>
      <div class="dialog-header"><div><span class="eyebrow">New invitation</span><h2 id="work-order-dialog-title">Invite someone to Tiger Ops</h2></div><button type="button" class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>
      <div class="dialog-body">
        ${draft.error ? `<div class="form-alert error" role="alert">${escapeHtml(draft.error)}</div>` : ""}
        <div class="form-grid">
          <label>Email<input name="email" type="email" required value="${escapeHtml(draft.email)}" placeholder="name@gram.edu" /></label>
          <label><span>Name <span class="optional">optional</span></span><input name="fullName" maxlength="120" value="${escapeHtml(draft.fullName)}" /></label>
          <label>Role<select name="role">${me().canInvite.map((key) => `<option value="${key}" ${key === draft.role ? "selected" : ""}>${escapeHtml(roleTemplates[key].label)}</option>`).join("")}</select></label>
          <label>Department<select name="orgId">${orgs.map((unit) => `<option value="${unit.id}" ${unit.id === draft.orgId ? "selected" : ""}>${escapeHtml(unit.name)}</option>`).join("")}</select></label>
          <label>Access length<select name="accessDays">${durations.map(([value, label]) => `<option value="${value}" ${value === draft.accessDays ? "selected" : ""}>${label}</option>`).join("")}</select>
            <small class="field-help">${template.maxAccessDays ? `${escapeHtml(template.label)} access is capped at ${template.maxAccessDays} days.` : "Access ends automatically on the chosen date."}</small></label>
          <label>Link valid for<select name="validHours">${[["24", "24 hours"], ["72", "3 days"], ["168", "7 days"], ["336", "14 days"]].map(([value, label]) => `<option value="${value}" ${value === draft.validHours ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          ${template.buildingScoped ? `<fieldset class="span-2 check-grid"><legend>Halls</legend>${invitableHalls().map((hall) => `<label class="checkbox-row"><input type="checkbox" name="buildingIds" value="${hall.id}" ${draft.buildingIds.includes(hall.id) ? "checked" : ""}/> ${escapeHtml(hall.name)}</label>`).join("")}</fieldset>` : ""}
          <fieldset class="span-2 check-grid"><legend>Features <span class="optional">switch off anything they don't need</span></legend>${template.permissions.map((permission) => `<label class="checkbox-row"><input type="checkbox" name="permissions" value="${permission}" ${draft.permissions.includes(permission) ? "checked" : ""}/> ${escapeHtml(featureLabels[permission] || permission)}</label>`).join("")}</fieldset>
          <label class="span-2"><span>Note to include <span class="optional">optional</span></span><textarea name="note" rows="2" maxlength="500">${escapeHtml(draft.note)}</textarea></label>
        </div>
        <p class="panel-subtitle">${escapeHtml(template.explanation)}</p>
      </div>
      <div class="dialog-actions">
        <button type="button" class="button secondary" data-dialog-close>Cancel</button>
        <button class="button primary" ${draft.busy ? "disabled" : ""}>${draft.busy ? "Sending…" : "Send invitation"}</button>
      </div>
    </form>`;
}

function openInviteDialog() {
  state.inviteDraft = defaultDraft();
  workOrderDialogContent.innerHTML = renderInviteDialog();
  workOrderDialog.showModal();
}

function readInviteForm(form) {
  const data = new FormData(form);
  Object.assign(state.inviteDraft, {
    email: String(data.get("email") || "").trim(),
    fullName: String(data.get("fullName") || ""),
    orgId: String(data.get("orgId") || ""),
    accessDays: String(data.get("accessDays") ?? ""),
    validHours: String(data.get("validHours") || "72"),
    buildingIds: data.getAll("buildingIds").map(String),
    permissions: data.getAll("permissions").map(String),
    note: String(data.get("note") || "")
  });
}

async function submitInvite(form) {
  readInviteForm(form);
  const draft = state.inviteDraft;
  if (!form.reportValidity()) return;
  if (!draft.permissions.length) {
    draft.error = "Leave at least one feature switched on.";
    workOrderDialogContent.innerHTML = renderInviteDialog();
    return;
  }
  draft.busy = true;
  draft.error = "";
  workOrderDialogContent.innerHTML = renderInviteDialog();
  try {
    draft.result = await api.post("/api/invitations", {
      email: draft.email,
      fullName: draft.fullName,
      role: draft.role,
      orgId: draft.orgId,
      buildingIds: draft.buildingIds,
      permissions: draft.permissions,
      accessDays: draft.accessDays ? Number(draft.accessDays) : null,
      validHours: Number(draft.validHours),
      note: draft.note
    });
    await loadPeople();
    state.peopleTab = "invitations";
    render();
  } catch (error) {
    draft.error = error.message;
  }
  draft.busy = false;
  workOrderDialogContent.innerHTML = renderInviteDialog();
}

function openFeaturesDialog(person) {
  const template = roleTemplates[person.role];
  workOrderDialogContent.innerHTML = `
    <form id="features-form" data-person-id="${escapeHtml(person.id)}">
      <div class="dialog-header"><div><span class="eyebrow">${escapeHtml(person.roleLabel)}</span><h2 id="work-order-dialog-title">Features for ${escapeHtml(person.name)}</h2></div><button type="button" class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>
      <div class="dialog-body">
        <fieldset class="check-grid"><legend>Enabled features</legend>${template.permissions.map((permission) => `<label class="checkbox-row"><input type="checkbox" name="permissions" value="${permission}" ${person.permissions.includes(permission) ? "checked" : ""}/> ${escapeHtml(featureLabels[permission] || permission)}</label>`).join("")}</fieldset>
        <p class="panel-subtitle">Takes effect on their next request. Features outside the role can't be added.</p>
      </div>
      <div class="dialog-actions"><button type="button" class="button secondary" data-dialog-close>Cancel</button><button class="button primary">Save features</button></div>
    </form>`;
  workOrderDialog.showModal();
}

async function personAction(personId, action) {
  const person = state.people.find((item) => item.id === personId);
  if (!person) return;
  if (action === "features") {
    openFeaturesDialog(person);
    return;
  }
  if ((action === "end_access" || action === "suspend") && !window.confirm(`${action === "suspend" ? "Suspend" : "End access for"} ${person.name}? They'll be signed out right away.`)) return;
  const body = action.startsWith("extend") ? { action: "extend", days: Number(action.split("-")[1]) } : { action };
  await guard(async () => {
    await api.patch(`/api/people/${personId}`, body);
    await loadPeople();
    render();
    showToast(`Access updated for ${person.name}.`);
  });
}

async function inviteAction(inviteId, action) {
  const invite = state.invitations.find((item) => item.id === inviteId);
  if (!invite) return;
  if (action === "revoke") {
    if (!window.confirm(`Revoke the invitation to ${invite.email}? The link will stop working.`)) return;
    await guard(async () => {
      await api.post(`/api/invitations/${inviteId}/revoke`);
      await loadPeople();
      render();
      showToast("Invitation revoked.");
    });
    return;
  }
  await guard(async () => {
    const result = await api.post(`/api/invitations/${inviteId}/resend`);
    await loadPeople();
    render();
    state.inviteDraft = { ...defaultDraft(invite.role), email: invite.email, result };
    workOrderDialogContent.innerHTML = renderInviteDialog();
    workOrderDialog.showModal();
  });
}

/* ---------- Account ---------- */

function renderAccount() {
  const user = me();
  const r = role();
  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading"><div><span class="eyebrow">Your profile</span><h1>My account</h1><p>What Tiger Ops knows about you, what you can do, and for how long.</p></div></header>
      <section class="org-layout">
        <article class="panel">
          <div class="account-head"><span class="avatar large">${escapeHtml(initials(user.name))}</span><div><h2 class="section-title">${escapeHtml(user.name)}</h2><p class="panel-subtitle">${escapeHtml(user.email)}</p></div></div>
          <div class="building-meta">
            <div><span>Role</span><strong>${escapeHtml(r.label)}</strong></div>
            <div><span>Access level</span><strong>${escapeHtml(r.level)}</strong></div>
            <div><span>Department</span><strong>${escapeHtml(user.orgId ? orgName(user.orgId) : "—")}</strong></div>
            <div><span>Scope</span><strong>${escapeHtml(roleScopeLabel())}</strong></div>
            ${user.buildingIds?.length ? `<div><span>Halls</span><strong>${escapeHtml(user.buildingIds.map(buildingName).join(", "))}</strong></div>` : ""}
            ${user.role === "student" ? `<div><span>Residence</span><strong>${escapeHtml(user.buildingId ? `${buildingName(user.buildingId)} ${user.room || ""}` : "Not set")}</strong></div>` : ""}
            <div><span>Access</span><strong>${escapeHtml(accessLabel(user.accessExpiresAt))}</strong></div>
            <div><span>Invited by</span><strong>${escapeHtml(user.invitedByName || (user.role === "student" ? "Self-registered" : "—"))}</strong></div>
            <div><span>Member since</span><strong>${formatDate(user.createdAt, false)}</strong></div>
          </div>
          <h3>Enabled features</h3>
          <ul class="feature-pills">${r.permissions.map((permission) => `<li>${escapeHtml(featureLabels[permission] || permission)}</li>`).join("")}</ul>
        </article>
        <aside class="panel stacked-forms">
          <form class="form-stack" id="profile-form">
            <h2 class="section-title">Profile</h2>
            <label>Full name<input name="fullName" required maxlength="120" value="${escapeHtml(user.name)}" /></label>
            ${user.buildingId ? `<label>Room in ${escapeHtml(buildingName(user.buildingId))}<input name="homeRoom" maxlength="16" value="${escapeHtml(user.room || "")}" /></label>` : ""}
            <button class="button primary">Save profile</button>
          </form>
          <form class="form-stack" id="password-form">
            <h2 class="section-title">Password</h2>
            <label>Current password<input name="current" type="password" autocomplete="current-password" required /></label>
            <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="10" /></label>
            <label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" required minlength="10" /></label>
            <small class="field-help">Changing it signs you out everywhere else.</small>
            <button class="button secondary">Change password</button>
          </form>
        </aside>
      </section>
    </div>`;
}

/* ---------- Audit ---------- */

function renderAudit() {
  const summaryOnly = role().permissions.includes("audit:view:summary");
  const events = state.auditEvents;
  pageRoot.innerHTML = `
    <div class="view">
      <header class="page-heading"><div><span class="eyebrow">Accountability</span><h1>Audit history</h1><p>Work order changes, invitations, and access changes are written by the database itself, so they can't be skipped.</p></div></header>
      <section class="panel">
        ${summaryOnly ? `<div class="notice"><strong>Summary-only audit access</strong>Your role sees audit health, not individual user activity. Ask the Compliance Auditor for a scoped review.</div>`
          : events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>Department</th></tr></thead><tbody>${events.map((event) => `<tr><td>${formatDate(event.at)}</td><td>${escapeHtml(event.actor)}</td><td>${escapeHtml(event.action)}</td><td><strong>${escapeHtml(event.target)}</strong></td><td>${escapeHtml(event.detail || "")}</td><td>${escapeHtml(orgName(event.orgId))}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="empty-state">Your role doesn't include audit records.</div>`}
      </section>
    </div>`;
}

/* ---------- Tiger role-based copilot ---------- */

function agentActionDetails(action) {
  if (!action) return "";
  if (action.type === "send_email") {
    return `<dl class="agent-action-details"><div><dt>To</dt><dd>${escapeHtml(action.args.to)}</dd></div><div><dt>Subject</dt><dd>${escapeHtml(action.args.subject)}</dd></div></dl><pre>${escapeHtml(action.args.body)}</pre>`;
  }
  if (action.type === "update_work_order") {
    return `<p>Requested change: <strong>${escapeHtml(action.args.ref)}</strong> → ${escapeHtml(statusLabels[action.args.status] || titleCase(action.args.status))}</p>`;
  }
  return "";
}

function renderAgent() {
  if (!state.user) return;
  agentPanel.hidden = !state.agent.open;
  agentLauncher.hidden = state.agent.open;
  agentLauncher.setAttribute("aria-expanded", String(state.agent.open));
  document.querySelector("#agent-role").textContent = `${state.user.roleLabel} · ${state.user.role === "president" ? "aggregate scope" : roleScopeLabel()}`;
  agentMessages.innerHTML = state.agent.messages.map((message) => `
    <article class="agent-message ${message.role}">
      <span class="agent-message-label">${message.role === "assistant" ? "Tiger" : "You"}</span>
      <p>${escapeHtml(message.text)}</p>
      ${message.action ? `<div class="agent-action-card"><span>Approval required</span><strong>${escapeHtml(message.action.label)}</strong>${agentActionDetails(message.action)}<div><button type="button" class="button secondary" data-agent-cancel>Cancel</button><button type="button" class="button primary" data-agent-confirm>Approve action</button></div></div>` : ""}
    </article>`).join("") + (state.agent.busy ? `<article class="agent-message assistant is-thinking"><span></span><span></span><span></span><small>Checking your role and scoped data…</small></article>` : "");
  agentSuggestions.innerHTML = state.agent.suggestions.map((suggestion) => `<button type="button" data-agent-prompt="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>`).join("");
  agentInput.disabled = state.agent.busy;
  agentForm.querySelector(".agent-send").disabled = state.agent.busy;
  agentVoice.classList.toggle("is-active", state.agent.voice);
  agentVoice.setAttribute("aria-pressed", String(state.agent.voice));
  agentVoice.setAttribute("aria-label", state.agent.voice ? "Turn spoken responses off" : "Turn spoken responses on");
  agentMic.classList.toggle("is-listening", state.agent.listening);
  agentMic.textContent = state.agent.listening ? "Listening" : "Mic";
  requestAnimationFrame(() => { agentMessages.scrollTop = agentMessages.scrollHeight; });
}

function speakAgent(text) {
  if (!state.agent.voice || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.96;
  window.speechSynthesis.speak(utterance);
}

function navigateToBuilding(buildingId) {
  const building = getBuilding(buildingId);
  if (!building) return;
  state.selectedBuildingId = buildingId;
  state.mapFilter = "all";
  state.mapQuery = "";
  state.routeActive = true;
  state.activeView = "map";
  render();
  document.querySelector("#main-content")?.focus();
}

function locateUserOnCampus() {
  if (!navigator.geolocation) {
    state.locationMessage = "GPS is not available in this browser. The route will start at the south campus entrance.";
    renderMap();
    return;
  }
  state.locationMessage = "Requesting your location…";
  renderMap();
  navigator.geolocation.getCurrentPosition((position) => {
    // Calibrated prototype bounds around the official campus map. A production
    // deployment should replace this affine projection with surveyed paths.
    const bounds = { west: -92.7305, east: -92.7060, north: 32.5275, south: 32.5098 };
    const { latitude, longitude } = position.coords;
    const inside = longitude >= bounds.west && longitude <= bounds.east && latitude >= bounds.south && latitude <= bounds.north;
    if (!inside) {
      state.userMapPoint = null;
      state.locationMessage = "Your GPS position is outside the mapped campus. Routing from the south campus entrance instead.";
    } else {
      state.userMapPoint = {
        x: Math.round(30 + ((longitude - bounds.west) / (bounds.east - bounds.west)) * 1580),
        y: Math.round(30 + ((bounds.north - latitude) / (bounds.north - bounds.south)) * 1220),
        label: "You"
      };
      state.routeActive = true;
      state.locationMessage = `GPS located you on campus (about ±${Math.round(position.coords.accuracy)} m). Your precise coordinates stay in this browser.`;
    }
    renderMap();
  }, (error) => {
    state.userMapPoint = null;
    state.locationMessage = error.code === 1
      ? "Location permission was not granted. Routing from the south campus entrance instead."
      : "GPS could not determine your campus position. Routing from the south campus entrance instead.";
    renderMap();
  }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
}

async function executeAgentAction(action) {
  if (!action) return;
  if (action.type === "navigate_building") {
    navigateToBuilding(action.args.buildingId);
    return;
  }
  if (action.type === "open_view") {
    state.activeView = action.args.view;
    render();
    return;
  }
  state.agent.busy = true;
  renderAgent();
  try {
    let result;
    if (action.type === "update_work_order") {
      result = await api.patch(`/api/work-orders/${action.args.id}`, { status: action.args.status });
      await loadData();
      render();
      result.message = `${action.args.ref} is now ${statusLabels[action.args.status] || titleCase(action.args.status)}. The database recorded the change in the audit log.`;
    }
    if (action.type === "send_email") result = await api.post("/api/agent/email", action.args);
    state.agent.messages.push({ role: "assistant", text: result?.message || "Action completed." });
    state.agent.pending = null;
    speakAgent(result?.message || "Action completed.");
  } catch (error) {
    state.agent.messages.push({ role: "assistant", text: `I could not complete that action: ${error.message}` });
  } finally {
    state.agent.busy = false;
    renderAgent();
  }
}

async function submitAgentMessage(message) {
  const text = String(message || "").trim();
  if (!text || state.agent.busy) return;
  state.agent.messages.push({ role: "user", text });
  state.agent.pending = null;
  state.agent.suggestions = [];
  state.agent.busy = true;
  agentInput.value = "";
  renderAgent();
  try {
    const response = await api.post("/api/agent/chat", { message: text, context: { activeView: state.activeView, selectedBuildingId: state.selectedBuildingId } });
    const pending = response.action?.requiresConfirmation ? response.action : null;
    state.agent.pending = pending;
    state.agent.messages.push({ role: "assistant", text: response.message, action: pending });
    state.agent.suggestions = response.suggestions || [];
    agentRuntime.textContent = response.runtime.fallback
      ? "Demo router active · Start Ollama for open-weight reasoning"
      : `${response.runtime.provider} · ${response.runtime.model} · runs locally`;
    if (response.action && !response.action.requiresConfirmation) await executeAgentAction(response.action);
    speakAgent(response.message);
  } catch (error) {
    state.agent.messages.push({ role: "assistant", text: `I’m having trouble reaching the agent: ${error.message}` });
  } finally {
    state.agent.busy = false;
    renderAgent();
  }
}

/* ---------- Rendering ---------- */

function render() {
  if (!state.user) return;
  if (state.activeView === "people" && !canSeePeople()) state.activeView = "overview";
  pageTitle.textContent = viewTitles[state.activeView];
  if (window.location.hash.slice(1) !== state.activeView) window.history.replaceState(null, "", `#${state.activeView}`);
  workOrderCount.textContent = role().aggregateOnly ? "Σ" : String(state.workOrders.filter(isOpen).length);
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.view === state.activeView;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const views = { overview: renderOverview, "work-orders": renderWorkOrders, map: renderMap, floors: renderFloors, organization: renderOrganization, people: renderPeople, audit: renderAudit, account: renderAccount };
  views[state.activeView]();
}

/* ---------- Work order dialog ---------- */

async function loadAssignees() {
  if (state.assignees === null) state.assignees = (await api.get("/api/assignees")).assignees;
  return state.assignees;
}

async function openWorkOrder(orderId) {
  const order = state.workOrders.find((item) => item.id === orderId);
  if (!order) {
    showToast("That work order is outside your scope.");
    return;
  }
  const user = me();
  const canUpdate = canUpdateWorkOrder(user, order);
  const canAssign = canAssignWorkOrder(user, order);
  const canInternal = hasPermission(user, "work_order:view_internal") && (canUpdate || canAssign);
  const canPublic = order.requesterId === user.id || canUpdate || canAssign;
  const loaded = await guard(() => Promise.all([
    api.get(`/api/work-orders/${order.id}/timeline`),
    canAssign ? loadAssignees() : Promise.resolve([])
  ]));
  const [timeline, assignees] = loaded || [{ notes: [] }, []];

  workOrderDialogContent.innerHTML = `
    <div class="dialog-header"><div><span class="eyebrow">${escapeHtml(order.ref)} · ${escapeHtml(orgName(order.orgId))}</span><h2 id="work-order-dialog-title">${escapeHtml(order.title)}</h2></div><button class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>
    <div class="dialog-body">
      <div>${badge(order.status)} ${badge(order.priority)}</div>
      <p>${escapeHtml(order.description)}</p>
      <div class="detail-grid">
        <div><span>Location</span><strong>${escapeHtml(buildingName(order.buildingId))} · ${escapeHtml(order.room)}</strong></div>
        <div><span>Requested by</span><strong>${escapeHtml(order.requesterName || "—")}</strong></div>
        <div><span>Assigned to</span><strong>${escapeHtml(order.assigneeName || "Unassigned")}</strong></div>
        <div><span>Entry permission</span><strong>${order.entryAllowed ? "Approved" : "Appointment required"}</strong></div>
        <div><span>Created</span><strong>${formatDate(order.createdAt)}</strong></div>
        <div><span>Due</span><strong>${formatDate(order.dueAt)}</strong></div>
      </div>
      ${getBuilding(order.buildingId)?.floors && canViewFloorPlan(user, getBuilding(order.buildingId)) ? `<button class="button secondary" data-action="locate" data-building-id="${escapeHtml(order.buildingId)}" data-room="${escapeHtml(order.room)}">Show on floor plan</button>` : ""}
      ${(canUpdate || canAssign) ? `<div class="action-bar">
        ${canUpdate ? `<label>Status <select id="detail-status">${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${order.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>` : ""}
        ${canAssign ? `<label>Assign to <select id="detail-assignee"><option value="">Unassigned</option>${assignees.map((person) => `<option value="${person.id}" ${order.assigneeId === person.id ? "selected" : ""}>${escapeHtml(person.name)} · ${escapeHtml(person.orgName)}</option>`).join("")}</select></label>
          <label>Priority <select id="detail-priority">${["routine", "urgent", "emergency"].map((value) => `<option value="${value}" ${order.priority === value ? "selected" : ""}>${titleCase(value)}</option>`).join("")}</select></label>` : ""}
        <button class="button primary" data-action="save-order" data-id="${escapeHtml(order.id)}">Save changes</button>
      </div>` : `<div class="notice"><strong>Following this request</strong>Progress updates appear below. Status and assignment are handled by the responsible team.</div>`}
      <section class="timeline">
        <h3>Updates</h3>
        <ol>${timeline.notes.length ? timeline.notes.map((note) => `<li class="note ${note.visibility}"><div class="note-meta"><strong>${escapeHtml(note.author)}</strong>${note.visibility === "internal" ? `<span class="source-tag restricted">Staff only</span>` : `<span class="source-tag">Visible to requester</span>`}<time>${formatDate(note.createdAt)}</time></div><p>${escapeHtml(note.body)}</p></li>`).join("") : `<li class="empty-state">No updates yet.</li>`}</ol>
        ${canPublic || canInternal ? `<form id="note-form" data-id="${escapeHtml(order.id)}" class="note-form">
          <label class="sr-only" for="note-body">Add an update</label>
          <textarea id="note-body" name="body" rows="2" maxlength="2000" required placeholder="${order.requesterId === user.id && !canUpdate ? "Add details for the team, e.g. it's getting worse" : "Add an update"}"></textarea>
          <div class="note-actions">
            ${canPublic && canInternal ? `<select name="visibility" aria-label="Who can see this update"><option value="internal">Staff only</option><option value="public">Visible to requester</option></select>` : `<input type="hidden" name="visibility" value="${canInternal ? "internal" : "public"}" />`}
            <button class="button secondary">Post update</button>
          </div>
        </form>` : ""}
      </section>
    </div>`;
  if (!workOrderDialog.open) workOrderDialog.showModal();
}

async function updateWorkOrder(orderId) {
  const order = state.workOrders.find((item) => item.id === orderId);
  const body = {};
  const status = document.querySelector("#detail-status");
  const assignee = document.querySelector("#detail-assignee");
  const priority = document.querySelector("#detail-priority");
  if (status && status.value !== order.status) body.status = status.value;
  if (assignee && assignee.value !== (order.assigneeId || "")) body.assigneeId = assignee.value || null;
  if (priority && priority.value !== order.priority) body.priority = priority.value;
  if (!Object.keys(body).length) {
    showToast("Nothing changed.");
    return;
  }
  await guard(async () => {
    await api.patch(`/api/work-orders/${orderId}`, body);
    await loadData();
    render();
    showToast(`${order.ref} updated and recorded in the audit log.`);
    await openWorkOrder(orderId);
  });
}

function openCreateDialog(prefill = {}) {
  const user = me();
  if (!canCreateWorkOrder(user)) {
    showToast("Your role can't submit work orders.");
    return;
  }
  const buildingSelect = document.querySelector("#create-building");
  buildingSelect.innerHTML = creatableBuildings().map((building) => `<option value="${building.id}">${building.mapNo}. ${escapeHtml(building.name)}</option>`).join("");
  createForm.reset();
  const buildingId = prefill.buildingId || user.buildingId || user.buildingIds?.[0];
  if (buildingId && [...buildingSelect.options].some((option) => option.value === buildingId)) buildingSelect.value = buildingId;
  createForm.elements.room.value = prefill.room || (user.role === "student" ? user.room || "" : "");
  createDialog.showModal();
}

async function createWorkOrder(formData) {
  await guard(async () => {
    const result = await api.post("/api/work-orders", {
      title: formData.get("title"),
      description: formData.get("description"),
      category: formData.get("category"),
      priority: formData.get("priority"),
      buildingId: formData.get("buildingId"),
      room: formData.get("room"),
      entryAllowed: formData.get("entryAllowed") === "on"
    });
    createDialog.close();
    await loadData();
    state.activeView = "work-orders";
    state.orderFilter = "open";
    render();
    showToast(`${result.ref} created and routed to ${orgName(result.orgId)}.`);
  });
}

function openFloorPlan(buildingId, spaceId = null) {
  const building = getBuilding(buildingId);
  state.selectedBuildingId = buildingId;
  state.selectedSpaceId = spaceId;
  state.selectedFloor = 1;
  if (spaceId && building?.floors) {
    for (let floor = 1; floor <= building.floors; floor += 1) {
      if (generateFloorPlan(building, floor).spaces.some((space) => space.id === spaceId)) state.selectedFloor = floor;
    }
  }
  state.activeView = "floors";
  render();
}

/* ---------- Events ---------- */

document.querySelector("#primary-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  state.activeView = button.dataset.view;
  sidebar.classList.remove("is-open");
  mobileMenu.setAttribute("aria-expanded", "false");
  render();
  document.querySelector("#main-content").focus();
});

mobileMenu.addEventListener("click", () => {
  const open = sidebar.classList.toggle("is-open");
  mobileMenu.setAttribute("aria-expanded", String(open));
});

userChip.addEventListener("click", () => {
  const open = userPopover.hidden;
  userPopover.hidden = !open;
  userChip.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!userPopover.hidden && !event.target.closest(".user-menu")) {
    userPopover.hidden = true;
    userChip.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !userPopover.hidden) {
    userPopover.hidden = true;
    userChip.setAttribute("aria-expanded", "false");
    userChip.focus();
  }
});

userPopover.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  if (view) {
    state.activeView = view.dataset.view;
    render();
  }
  if (event.target.closest('[data-action="sign-out"]')) signOut();
  userPopover.hidden = true;
  userChip.setAttribute("aria-expanded", "false");
});

agentLauncher.addEventListener("click", () => {
  state.agent.open = true;
  renderAgent();
  agentInput.focus();
});

document.querySelector("#agent-close").addEventListener("click", () => {
  state.agent.open = false;
  window.speechSynthesis?.cancel();
  renderAgent();
  agentLauncher.focus();
});

agentVoice.addEventListener("click", () => {
  state.agent.voice = !state.agent.voice;
  if (!state.agent.voice) window.speechSynthesis?.cancel();
  renderAgent();
});

agentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAgentMessage(new FormData(agentForm).get("message"));
});

agentPanel.addEventListener("click", (event) => {
  const prompt = event.target.closest("[data-agent-prompt]");
  if (prompt) {
    submitAgentMessage(prompt.dataset.agentPrompt);
    return;
  }
  if (event.target.closest("[data-agent-cancel]")) {
    state.agent.pending = null;
    const message = [...state.agent.messages].reverse().find((item) => item.action);
    if (message) message.action = null;
    state.agent.messages.push({ role: "assistant", text: "Cancelled. No change was made." });
    renderAgent();
    return;
  }
  if (event.target.closest("[data-agent-confirm]") && state.agent.pending) {
    const action = state.agent.pending;
    state.agent.pending = null;
    const message = [...state.agent.messages].reverse().find((item) => item.action);
    if (message) message.action = null;
    executeAgentAction(action);
  }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.addEventListener("start", () => { state.agent.listening = true; renderAgent(); });
  recognition.addEventListener("end", () => { state.agent.listening = false; renderAgent(); });
  recognition.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    agentInput.value = transcript;
    submitAgentMessage(transcript);
  });
  recognition.addEventListener("error", () => {
    state.agent.listening = false;
    showToast("Voice input was unavailable. You can type the request instead.");
    renderAgent();
  });
  agentMic.hidden = false;
  agentMic.addEventListener("click", () => state.agent.listening ? recognition.stop() : recognition.start());
}

function handleActivate(event) {
  const orderRow = event.target.closest("[data-order-id]");
  if (orderRow) {
    openWorkOrder(orderRow.dataset.orderId);
    return;
  }
  const createButton = event.target.closest('[data-action="create-order"]');
  if (createButton) {
    openCreateDialog({ buildingId: createButton.dataset.buildingId, room: createButton.dataset.room });
    return;
  }
  if (event.target.closest('[data-action="invite"]')) {
    openInviteDialog();
    return;
  }
  const openFloors = event.target.closest('[data-action="open-floors"]');
  if (openFloors) {
    openFloorPlan(openFloors.dataset.buildingId);
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.orderFilter = filter.dataset.filter;
    renderWorkOrders();
    return;
  }
  const peopleTab = event.target.closest("[data-people-tab]");
  if (peopleTab) {
    state.peopleTab = peopleTab.dataset.peopleTab;
    renderPeople();
    return;
  }
  const peopleFilter = event.target.closest("[data-people-filter]");
  if (peopleFilter) {
    state.peopleFilter = peopleFilter.dataset.peopleFilter;
    renderPeople();
    return;
  }
  const personButton = event.target.closest("[data-person-action]");
  if (personButton) {
    personAction(personButton.dataset.personId, personButton.dataset.personAction);
    return;
  }
  const inviteButton = event.target.closest("[data-invite-action]");
  if (inviteButton) {
    inviteAction(inviteButton.dataset.inviteId, inviteButton.dataset.inviteAction);
    return;
  }
  const mapFilter = event.target.closest("[data-map-filter]");
  if (mapFilter) {
    state.mapFilter = mapFilter.dataset.mapFilter;
    renderMap();
    return;
  }
  const mapMode = event.target.closest("[data-map-mode]");
  if (mapMode) {
    state.mapMode = mapMode.dataset.mapMode;
    renderMap();
    return;
  }
  if (event.target.closest('[data-action="locate-me"]')) {
    locateUserOnCampus();
    return;
  }
  if (event.target.closest('[data-action="start-route"]')) {
    state.routeActive = true;
    renderMap();
    return;
  }
  const floor = event.target.closest("[data-floor]");
  if (floor) {
    state.selectedFloor = Number(floor.dataset.floor);
    state.selectedSpaceId = null;
    renderFloors();
    return;
  }
  const buildingButton = event.target.closest("[data-building-id]");
  if (buildingButton && state.activeView === "map") {
    state.selectedBuildingId = buildingButton.dataset.buildingId;
    renderMap();
    document.querySelector(`.map-marker[data-building-id="${state.selectedBuildingId}"]`)?.focus();
    return;
  }
  const spaceButton = event.target.closest("[data-space-id]");
  if (spaceButton) {
    state.selectedSpaceId = spaceButton.dataset.spaceId;
    renderFloors();
    document.querySelector(`[data-space-id="${CSS.escape(state.selectedSpaceId)}"]`)?.focus();
  }
}

pageRoot.addEventListener("click", handleActivate);
pageRoot.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("g[role='button'], tr[data-space-id], tr[data-order-id]")) {
    event.preventDefault();
    handleActivate(event);
  }
});

function rerenderKeepingFocus(selector, renderFn) {
  const input = document.querySelector(selector);
  const caret = input?.selectionStart ?? 0;
  renderFn();
  const next = document.querySelector(selector);
  next?.focus();
  next?.setSelectionRange(caret, caret);
}

pageRoot.addEventListener("input", (event) => {
  if (event.target.id === "map-search") {
    state.mapQuery = event.target.value;
    rerenderKeepingFocus("#map-search", renderMap);
  }
  if (event.target.id === "people-search") {
    state.peopleQuery = event.target.value;
    rerenderKeepingFocus("#people-search", renderPeople);
  }
});

pageRoot.addEventListener("change", (event) => {
  if (event.target.id === "plan-building") {
    state.selectedBuildingId = event.target.value;
    state.selectedFloor = 1;
    state.selectedSpaceId = null;
    renderFloors();
    return;
  }
  const layer = event.target.dataset.layer;
  if (layer === "work") state.showWork = event.target.checked;
  if (layer === "occupancy") state.showOccupancy = event.target.checked;
  if (layer === "table") state.planAsTable = event.target.checked;
  if (layer) renderFloors();
});

pageRoot.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  if (form.id === "profile-form") {
    await guard(async () => {
      const { user } = await api.patch("/api/account", { fullName: data.get("fullName"), homeRoom: data.get("homeRoom") });
      state.user = user;
      renderUserChrome();
      render();
      showToast("Profile saved.");
    });
  }
  if (form.id === "password-form") {
    if (data.get("password") !== data.get("confirm")) {
      showToast("New passwords don't match.");
      return;
    }
    await guard(async () => {
      await api.post("/api/account/password", { current: data.get("current"), next: data.get("password") });
      form.reset();
      showToast("Password changed. Other sessions were signed out.");
    });
  }
});

window.addEventListener("hashchange", () => {
  const view = window.location.hash.slice(1);
  if (state.user && viewTitles[view] && view !== state.activeView) {
    state.activeView = view;
    render();
  }
});

workOrderDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-dialog-close]")) {
    workOrderDialog.close();
    return;
  }
  const save = event.target.closest('[data-action="save-order"]');
  if (save) updateWorkOrder(save.dataset.id);
  const locate = event.target.closest('[data-action="locate"]');
  if (locate) {
    workOrderDialog.close();
    openFloorPlan(locate.dataset.buildingId, locate.dataset.room);
  }
  const inviteUi = event.target.closest("[data-invite-ui]")?.dataset.inviteUi;
  if (inviteUi === "copy") {
    const input = document.querySelector("#invite-link");
    navigator.clipboard?.writeText(input.value).then(() => showToast("Link copied."), () => { input.select(); showToast("Press Ctrl+C to copy."); });
  }
  if (inviteUi === "another") {
    state.inviteDraft = defaultDraft(state.inviteDraft.role);
    workOrderDialogContent.innerHTML = renderInviteDialog();
  }
});

workOrderDialog.addEventListener("change", (event) => {
  const form = event.target.closest("#invite-form");
  if (!form || event.target.name !== "role") return;
  readInviteForm(form);
  const kept = { email: state.inviteDraft.email, fullName: state.inviteDraft.fullName, note: state.inviteDraft.note };
  state.inviteDraft = { ...defaultDraft(event.target.value), ...kept };
  workOrderDialogContent.innerHTML = renderInviteDialog();
  workOrderDialogContent.querySelector('[name="role"]').focus();
});

workOrderDialog.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "invite-form") {
    submitInvite(form);
    return;
  }
  if (form.id === "features-form") {
    const permissions = new FormData(form).getAll("permissions").map(String);
    if (!permissions.length) {
      showToast("Leave at least one feature switched on.");
      return;
    }
    await guard(async () => {
      await api.patch(`/api/people/${form.dataset.personId}`, { action: "set_features", permissions });
      workOrderDialog.close();
      await loadPeople();
      render();
      showToast("Features updated.");
    });
    return;
  }
  if (form.id === "note-form") {
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    await guard(async () => {
      await api.post(`/api/work-orders/${form.dataset.id}/notes`, { body: data.get("body"), visibility: data.get("visibility") });
      await loadData();
      render();
      await openWorkOrder(form.dataset.id);
      showToast("Update posted.");
    });
  }
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    createDialog.close();
    return;
  }
  if (!createForm.reportValidity()) return;
  createWorkOrder(new FormData(createForm));
});

/* ---------- Boot ---------- */

async function boot() {
  const params = new URLSearchParams(window.location.search);
  let session;
  try {
    session = await api.get("/api/session");
  } catch {
    bootScreen.textContent = "Tiger Ops can't reach its server. Start it with npm run dev.";
    return;
  }
  state.demo = session.demo;

  if (initialAuthHash?.get("access_token")) {
    const type = initialAuthHash.get("type");
    const accessToken = initialAuthHash.get("access_token");
    window.history.replaceState(null, "", window.location.pathname);
    if (type === "recovery") return showAuth("reset", { token: accessToken });
    if (["signup", "email_change"].includes(type)) {
      return showAuth("login", { notice: "Email verified. Sign in to continue." });
    }
  }

  if (params.get("invite")) return showAuth("invite", { token: params.get("invite"), preview: null });
  if (params.get("verify")) return showAuth("verify", { token: params.get("verify") });
  if (params.get("reset") === "request") return showAuth("forgot");
  if (params.get("reset")) return showAuth("reset", { token: params.get("reset") });
  if (params.has("mailbox") && state.demo) return showAuth("mailbox");

  if (session.user) await enterApp(session.user);
  else showAuth("login");
}

boot();

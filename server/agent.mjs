import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildings, buildingTypes } from "../data.js";

const root = resolve(import.meta.dirname, "..");
const campusDomains = new Set(["gram.edu", "gsumail.gram.edu"]);
const allowedViews = new Set(["overview", "work-orders", "map", "floors", "organization", "people", "audit", "account"]);

const roleSkills = {
  president: ".agents/skills/executive-campus-briefing/SKILL.md",
  housingDirector: ".agents/skills/housing-operations/SKILL.md"
};

function loadSkill(role) {
  const path = roleSkills[role];
  if (!path) return "Use only public campus navigation. Do not propose administrative actions.";
  try {
    return readFileSync(resolve(root, path), "utf8").replace(/^---[\s\S]*?---\s*/, "").slice(0, 12_000);
  } catch {
    return "Apply least privilege. Explain access limits and require confirmation before any side effect.";
  }
}

const clean = (value, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function findBuilding(message) {
  const query = normalize(message);
  return buildings.find((building) => {
    const name = normalize(building.name);
    const tokens = name.split(" ").filter((token) => token.length > 3 && !["hall", "building", "center", "complex"].includes(token));
    return query.includes(name) || tokens.some((token) => query.includes(token)) || query.includes(`map ${building.mapNo}`);
  });
}

function campusEmail(value) {
  const email = clean(value, 254).toLowerCase();
  const domain = email.split("@")[1];
  return /^[^\s@]+@[^\s@]+$/.test(email) && campusDomains.has(domain) ? email : null;
}

function roleCan(profile, permission) {
  return Array.isArray(profile?.permissions) && profile.permissions.includes(permission);
}

function operationalSummary(profile, workOrders, summary) {
  if (profile.role === "president") {
    const total = summary.reduce((value, row) => value + Number(row.total || 0), 0);
    const open = summary.reduce((value, row) => value + Number(row.open || 0), 0);
    const urgent = summary.reduce((value, row) => value + Number(row.urgent || 0), 0);
    return `Across approved aggregates there are ${open} open items, ${urgent} urgent, and ${total} total records. I will not expose row-level request details to the President role.`;
  }
  const open = workOrders.filter((order) => !["completed", "cancelled"].includes(order.status));
  const urgent = open.filter((order) => order.priority !== "routine");
  const unassigned = open.filter((order) => !order.assigneeId);
  return `In your scoped queue: ${open.length} open, ${urgent.length} urgent, and ${unassigned.length} unassigned. I can open a location or prepare a confirmed update.`;
}

function proposedAction(type, args, label) {
  const safe = ["navigate_building", "open_view"].includes(type);
  return { type, args, label, requiresConfirmation: !safe };
}

export function fallbackAgentResponse({ profile, message, workOrders = [], summary = [] }) {
  const input = clean(message, 1000);
  const lower = input.toLowerCase();
  const building = findBuilding(input);

  if (building && /show|find|where|navigate|route|take me|directions|locate/.test(lower)) {
    return {
      message: `Opening the campus digital twin and routing to ${building.name}. The route is a campus-map estimate; use the GPS button for a live starting point.`,
      action: proposedAction("navigate_building", { buildingId: building.id }, `Navigate to ${building.name}`),
      suggestions: ["Start a GPS route", `Show ${building.name} floor plans`, "What is open in housing?"]
    };
  }

  if (/summary|brief|pulse|what.*open|status/.test(lower)) {
    return {
      message: operationalSummary(profile, workOrders, summary),
      action: null,
      suggestions: profile.role === "president" ? ["Open the executive dashboard", "Draft a campus update", "Show me Bowen"] : ["Show urgent work", "Resolve a work order", "Show me Bowen"]
    };
  }

  const ref = input.match(/\bWO-?\s?(\d{3,})\b/i)?.[1];
  const order = ref ? workOrders.find((item) => String(item.ref).toUpperCase() === `WO-${ref}`) : null;
  const status = /resolve|complete|fixed|close/.test(lower) ? "completed" : /in progress|start work/.test(lower) ? "in_progress" : null;
  if (ref && status) {
    if (!roleCan(profile, "work_order:update") || !order) {
      return {
        message: profile.role === "president"
          ? "The President profile has aggregate-only access, so I cannot open or change an individual request. A Housing Director can perform that action."
          : `I cannot update WO-${ref}; it is outside this role's current scope or is not editable.`,
        action: null,
        suggestions: ["Show my operations summary", "Open work orders", "Show me Bowen"]
      };
    }
    return {
      message: `I found ${order.ref}: ${order.title}. I can change its status to ${status === "completed" ? "Completed" : "In progress"}. Nothing changes until you approve.`,
      action: proposedAction("update_work_order", { id: order.id, ref: order.ref, status }, `Set ${order.ref} to ${status === "completed" ? "Completed" : "In progress"}`),
      suggestions: ["Open the work order", "Show its building", "Summarize the housing queue"]
    };
  }

  if (/email|message|write to|send to/.test(lower)) {
    if (!roleSkills[profile.role]) {
      return { message: "Email drafting is currently enabled for the President and Housing Director profiles only.", action: null, suggestions: ["Show me Bowen", "Open my dashboard"] };
    }
    const recipient = campusEmail(input.match(/[\w.+-]+@[\w.-]+/i)?.[0]);
    if (!recipient) {
      return { message: "Who should receive it? For this pilot I can send only to @gram.edu or @gsumail.gram.edu addresses.", action: null, suggestions: ["Email housing.director@gram.edu a housing update", "Draft an executive update"] };
    }
    const subject = profile.role === "president" ? "Campus operations update" : "Housing operations update";
    const body = profile.role === "president"
      ? `Hello,\n\nHere is the latest campus operations update: ${operationalSummary(profile, workOrders, summary)}\n\n— Office of the President`
      : `Hello,\n\nHere is the latest housing operations update: ${operationalSummary(profile, workOrders, summary)}\n\n— Campus Living & Housing`;
    return {
      message: `I drafted an email to ${recipient}. Review it before sending; the pilot delivers it to the auditable demo mailbox.`,
      action: proposedAction("send_email", { to: recipient, subject, body }, `Send email to ${recipient}`),
      suggestions: ["Revise the subject", "Show my operations summary", "Open audit history"]
    };
  }

  if (/work order|issues|requests/.test(lower)) {
    return { message: "Opening the work order center. I will keep the same role and record scope as your signed-in profile.", action: proposedAction("open_view", { view: "work-orders" }, "Open work orders"), suggestions: ["Show urgent work", "Resolve WO-1048", "Summarize the queue"] };
  }

  return {
    message: `I am your ${profile.roleLabel} copilot. I can brief the data this role is allowed to see, navigate the campus digital twin, draft campus email, and prepare work-order changes for approval.`,
    action: null,
    suggestions: ["Show me Bowen", "Give me an operations summary", profile.role === "housingDirector" ? "Resolve WO-1048" : "Draft an email"]
  };
}

function parseModelJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const block = String(content).match(/\{[\s\S]*\}/)?.[0];
    return block ? JSON.parse(block) : null;
  }
}

function validateModelResponse(result, context) {
  if (!result || typeof result.message !== "string") return null;
  const response = { message: clean(result.message, 2000), action: null, suggestions: Array.isArray(result.suggestions) ? result.suggestions.map((item) => clean(item, 80)).filter(Boolean).slice(0, 3) : [] };
  const action = result.action;
  if (!action || typeof action !== "object") return response;
  const type = action.type;
  const args = action.args || {};
  if (type === "navigate_building" && buildings.some((item) => item.id === args.buildingId)) response.action = proposedAction(type, { buildingId: args.buildingId }, clean(action.label, 120) || "Open campus route");
  if (type === "open_view" && allowedViews.has(args.view)) response.action = proposedAction(type, { view: args.view }, clean(action.label, 120) || "Open view");
  if (type === "update_work_order" && roleCan(context.profile, "work_order:update")) {
    const order = context.workOrders.find((item) => item.id === args.id || item.ref === args.ref);
    if (order && ["triage", "assigned", "in_progress", "waiting_parts", "completed", "cancelled"].includes(args.status)) {
      response.action = proposedAction(type, { id: order.id, ref: order.ref, status: args.status }, clean(action.label, 120) || `Update ${order.ref}`);
    }
  }
  if (type === "send_email" && roleSkills[context.profile.role]) {
    const to = campusEmail(args.to);
    const subject = clean(args.subject, 160);
    const body = clean(args.body, 4000);
    if (to && subject && body) response.action = proposedAction(type, { to, subject, body }, clean(action.label, 120) || `Send email to ${to}`);
  }
  return response;
}

async function askOllama(context) {
  const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen3:4b";
  const buildingCatalog = buildings.map((building) => ({ id: building.id, name: building.name, number: building.mapNo, type: buildingTypes[building.type] }));
  const visibleOrders = context.workOrders.map((order) => ({ id: order.id, ref: order.ref, title: order.title, status: order.status, priority: order.priority, buildingId: order.buildingId }));
  const system = `You are Tiger, a concise campus operations copilot. You run locally with an open-weight model.\n\nROLE\n${JSON.stringify({ role: context.profile.role, label: context.profile.roleLabel, permissions: context.profile.permissions })}\n\nACTIVE AGENT SKILL\n${loadSkill(context.profile.role)}\n\nCAMPUS BUILDINGS\n${JSON.stringify(buildingCatalog)}\n\nROLE-SCOPED DATA\n${JSON.stringify({ workOrders: visibleOrders, aggregates: context.summary })}\n\nReturn ONLY JSON with this shape: {"message":"...","action":null|{"type":"navigate_building|open_view|update_work_order|send_email","args":{},"label":"..."},"suggestions":["...","..."]}. Never claim an action already happened. Mutations require user confirmation. Never invent records, recipients, buildings, or permissions. Presidents receive aggregates only and cannot update individual work orders.`;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: context.message }], options: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 7000))
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json();
  const result = validateModelResponse(parseModelJson(payload?.message?.content), context);
  if (!result) throw new Error("Open model returned an invalid response");
  return { ...result, runtime: { provider: "Ollama", model, fallback: false } };
}

export async function answerAgent(context) {
  try {
    return await askOllama(context);
  } catch {
    return { ...fallbackAgentResponse(context), runtime: { provider: "Built-in demo router", model: null, fallback: true } };
  }
}

export function isCampusEmail(value) {
  return Boolean(campusEmail(value));
}

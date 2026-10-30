import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fallbackAgentResponse } from "../server/agent.mjs";
import { personas, roleTemplates } from "../data.js";

function profile(id) {
  const item = personas.find((person) => person.id === id);
  const role = roleTemplates[item.role];
  return { ...item, roleLabel: role.label, permissions: role.permissions };
}

const order = { id: "00000000-0000-4000-8000-000000000048", ref: "WO-1048", title: "Sink leaking under basin", status: "assigned", priority: "urgent", buildingId: "mildred-jones" };

test("campus agent routes a natural-language Bowen request", () => {
  const response = fallbackAgentResponse({ profile: profile("u-housing-director"), message: "Show me Bowen" });
  assert.equal(response.action.type, "navigate_building");
  assert.equal(response.action.args.buildingId, "jde-bowen");
  assert.equal(response.action.requiresConfirmation, false);
});

test("housing director can prepare, but not silently execute, a scoped resolution", () => {
  const response = fallbackAgentResponse({ profile: profile("u-housing-director"), message: "Resolve WO-1048", workOrders: [order] });
  assert.equal(response.action.type, "update_work_order");
  assert.equal(response.action.args.status, "completed");
  assert.equal(response.action.requiresConfirmation, true);
});

test("president remains aggregate-only for individual issues", () => {
  const response = fallbackAgentResponse({ profile: profile("u-president"), message: "Resolve WO-1048", workOrders: [] });
  assert.equal(response.action, null);
  assert.match(response.message, /aggregate-only/i);
});

test("agent skills use the Agent Skills Open Standard frontmatter", () => {
  for (const path of [
    ".agents/skills/executive-campus-briefing/SKILL.md",
    ".agents/skills/housing-operations/SKILL.md"
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /^---\nname: [a-z0-9-]+\ndescription: .+\nlicense: MIT\n/m);
  }
});

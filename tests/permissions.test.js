import test from "node:test";
import assert from "node:assert/strict";

import { initialWorkOrders, personas } from "../data.js";
import {
  canAssignWorkOrder,
  canUpdateWorkOrder,
  canViewWorkOrder,
  getDescendantIds,
  isOrgInScope,
  permissionDecision
} from "../permissions.js";

const persona = (id) => personas.find((item) => item.id === id);
const order = (id) => initialWorkOrders.find((item) => item.id === id);

test("housing scope contains nested Housing Maintenance", () => {
  const descendants = getDescendantIds("campus-living-housing");
  assert.ok(descendants.includes("housing-maintenance"));
  assert.ok(descendants.includes("residence-life"));
  assert.equal(isOrgInScope("campus-living-housing", "information-technology"), false);
});

test("housing director can view, update, and assign nested maintenance work", () => {
  const director = persona("u-housing-director");
  const housingWork = order("WO-1048");
  assert.equal(canViewWorkOrder(director, housingWork), true);
  assert.equal(canUpdateWorkOrder(director, housingWork), true);
  assert.equal(canAssignWorkOrder(director, housingWork), true);
});

test("housing director cannot access unrelated IT work", () => {
  const director = persona("u-housing-director");
  const itWork = order("WO-1045");
  assert.equal(canViewWorkOrder(director, itWork), false);
  assert.equal(canAssignWorkOrder(director, itWork), false);
});

test("technician sees assigned work but cannot assign it", () => {
  const tech = persona("u-tech");
  assert.equal(canViewWorkOrder(tech, order("WO-1048")), true);
  assert.equal(canUpdateWorkOrder(tech, order("WO-1048")), true);
  assert.equal(canAssignWorkOrder(tech, order("WO-1048")), false);
  assert.equal(canViewWorkOrder(tech, order("WO-1047")), false);
});

test("student sees only their own request", () => {
  const student = persona("u-student");
  assert.equal(canViewWorkOrder(student, order("WO-1048")), true);
  assert.equal(canViewWorkOrder(student, order("WO-1047")), false);
  assert.equal(canUpdateWorkOrder(student, order("WO-1048")), false);
});

test("president receives aggregate access rather than row-level access", () => {
  const president = persona("u-president");
  assert.equal(canViewWorkOrder(president, order("WO-1048")), false);
});

test("unknown actions deny by default", () => {
  const result = permissionDecision(persona("u-housing-director"), "work_order:delete", order("WO-1048"));
  assert.equal(result.allowed, false);
  assert.match(result.reason, /deny by default/i);
});

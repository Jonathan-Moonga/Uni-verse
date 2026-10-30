import test from "node:test";
import assert from "node:assert/strict";

import { buildings, initialWorkOrders, personas, roleTemplates, technicians } from "../data.js";
import {
  canAssignWorkOrder,
  canUpdateWorkOrder,
  canViewFloorPlan,
  canViewOccupancy,
  canViewWorkOrder,
  getScopedOrgIds,
  isOrgInScope,
  redactWorkOrder,
  routeWorkOrder
} from "../permissions.js";

const persona = (id) => personas.find((item) => item.id === id);
const order = (id) => initialWorkOrders.find((item) => item.id === id);
const building = (id) => buildings.find((item) => item.id === id);

test("every persona maps to a defined role", () => {
  for (const item of personas) assert.ok(roleTemplates[item.role], item.id);
});

test("sensitive units break hierarchical inheritance", () => {
  assert.equal(isOrgInScope("student-affairs", "housing-maintenance"), true);
  assert.equal(isOrgInScope("student-affairs", "health-center"), false);
  assert.equal(isOrgInScope("student-affairs", "health-center", ["health-center"]), true);
  assert.equal(isOrgInScope("health-center", "health-center"), true);
  assert.equal(getScopedOrgIds(persona("u-vpsa")).includes("counseling"), false);
});

test("VP of Student Affairs reaches nested housing maintenance but not the Health Center queue", () => {
  const vp = persona("u-vpsa");
  assert.equal(canViewWorkOrder(vp, order("WO-1048")), true);
  assert.equal(canAssignWorkOrder(vp, order("WO-1048")), true);
  assert.equal(canViewWorkOrder(vp, order("WO-1052")), false);
  assert.equal(canViewWorkOrder(vp, order("WO-1045")), false);
});

test("Health Center director owns the restricted queue; auditor reads it without editing", () => {
  assert.equal(canAssignWorkOrder(persona("u-health"), order("WO-1052")), true);
  assert.equal(canViewWorkOrder(persona("u-auditor"), order("WO-1052")), true);
  assert.equal(canUpdateWorkOrder(persona("u-auditor"), order("WO-1052")), false);
});

test("hall director is limited to supervised halls and cannot assign", () => {
  const hd = persona("u-hall-director");
  assert.equal(canViewWorkOrder(hd, order("WO-1048")), true);
  assert.equal(canViewWorkOrder(hd, order("WO-1047")), true);
  assert.equal(canViewWorkOrder(hd, order("WO-1049")), false);
  assert.equal(canViewWorkOrder(hd, order("WO-1046")), false);
  assert.equal(canUpdateWorkOrder(hd, order("WO-1048")), true);
  assert.equal(canAssignWorkOrder(hd, order("WO-1048")), false);
});

test("RA sees their hall read-only with minimized identity and no internal notes", () => {
  const ra = persona("u-ra");
  assert.equal(canViewWorkOrder(ra, order("WO-1050")), true);
  assert.equal(canViewWorkOrder(ra, order("WO-1048")), true);
  assert.equal(canViewWorkOrder(ra, order("WO-1049")), false);
  assert.equal(canUpdateWorkOrder(ra, order("WO-1050")), false);
  const redacted = redactWorkOrder(ra, order("WO-1048"));
  assert.equal(redacted.internalNote, undefined);
  assert.match(redacted.requesterName, /minimized/);
});

test("IT scope follows department, not building: residence-hall IT yes, housing plumbing no", () => {
  const it = persona("u-it");
  assert.equal(canViewWorkOrder(it, order("WO-1051")), true);
  assert.equal(canViewWorkOrder(it, order("WO-1048")), false);
  // Housing filed WO-1051, so it can follow the ticket, but IT owns the work.
  const housing = persona("u-housing-director");
  assert.equal(canViewWorkOrder(housing, order("WO-1051")), true);
  assert.equal(canUpdateWorkOrder(housing, order("WO-1051")), false);
  assert.equal(canAssignWorkOrder(housing, order("WO-1051")), false);
});

test("technician keeps internal notes but not resident identity", () => {
  const redacted = redactWorkOrder(persona("u-tech"), order("WO-1048"));
  assert.ok(redacted.internalNote);
  assert.match(redacted.requesterName, /minimized/);
});

test("floor plan and occupancy layers respect role and building scope", () => {
  const jones = building("mildred-jones");
  const holland = building("holland");
  assert.equal(canViewFloorPlan(persona("u-student"), jones), true);
  assert.equal(canViewFloorPlan(persona("u-student"), holland), false);
  assert.equal(canViewOccupancy(persona("u-student"), jones), false);
  assert.equal(canViewFloorPlan(persona("u-ra"), jones), true);
  assert.equal(canViewOccupancy(persona("u-ra"), jones), false);
  assert.equal(canViewOccupancy(persona("u-hall-director"), jones), true);
  assert.equal(canViewOccupancy(persona("u-hall-director"), holland), false);
  assert.equal(canViewFloorPlan(persona("u-president"), jones), false);
  assert.equal(canViewFloorPlan(persona("u-housing-director"), building("track-field")), false);
});

test("routing sends residence work to nested housing maintenance and IT to the help desk", () => {
  const student = persona("u-student");
  assert.equal(routeWorkOrder(student, "Plumbing", building("mildred-jones")), "housing-maintenance");
  assert.equal(routeWorkOrder(student, "IT support", building("mildred-jones")), "it-help-desk");
  assert.equal(routeWorkOrder(persona("u-health"), "Plumbing", building("foster-johnson")), "health-center");
  assert.equal(routeWorkOrder(persona("u-facilities"), "Plumbing", building("foster-johnson")), "facilities-management");
});

test("every assignable staff member belongs to a real unit", () => {
  for (const tech of technicians) assert.ok(isOrgInScope("university", tech.orgId, [tech.orgId]), tech.id);
});

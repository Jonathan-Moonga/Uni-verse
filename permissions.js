import { organization, roleTemplates } from "./data.js";

const organizationById = new Map(organization.map((unit) => [unit.id, unit]));

// A profile may narrow its template: its own scope root (the department it was
// invited into) and the subset of features its inviter enabled.
export function getRole(persona) {
  const template = roleTemplates[persona?.role];
  if (!template) return undefined;
  return {
    ...template,
    scopeOrgId: persona.scopeOrgId ?? template.scopeOrgId,
    permissions: persona.permissions ?? template.permissions
  };
}

export function hasPermission(persona, permission) {
  const role = getRole(persona);
  return Boolean(role?.permissions.includes(permission));
}

export function getOrganization(orgId) {
  return organizationById.get(orgId);
}

export function getDescendantIds(rootOrgId) {
  if (!rootOrgId) return [];
  const descendants = new Set([rootOrgId]);
  let found = true;
  while (found) {
    found = false;
    for (const unit of organization) {
      if (unit.parentId && descendants.has(unit.parentId) && !descendants.has(unit.id)) {
        descendants.add(unit.id);
        found = true;
      }
    }
  }
  return [...descendants];
}

export function getOrganizationPath(orgId) {
  if (!orgId) return [];
  const path = [];
  let current = organizationById.get(orgId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? organizationById.get(current.parentId) : null;
  }
  return path;
}

// Hierarchy grants inherited reach, except through units marked sensitive
// (health, counseling, conduct, police). A sensitive unit is reachable only when
// it is the scope root itself or the role holds an explicit grant for it.
export function isOrgInScope(scopeOrgId, targetOrgId, sensitiveGrants = []) {
  if (!scopeOrgId || !targetOrgId) return false;
  const path = getOrganizationPath(targetOrgId);
  const rootIndex = path.findIndex((unit) => unit.id === scopeOrgId);
  if (rootIndex === -1) return false;
  return path.slice(rootIndex + 1).every((unit) => !unit.sensitive || sensitiveGrants.includes(unit.id));
}

export function getScopedOrgIds(persona) {
  const role = getRole(persona);
  if (!role?.scopeOrgId) return [];
  return getDescendantIds(role.scopeOrgId).filter((id) => isOrgInScope(role.scopeOrgId, id, role.sensitiveGrants));
}

export function isBuildingInScope(persona, buildingId) {
  const role = getRole(persona);
  if (!role?.buildingScoped) return true;
  return (persona.buildingIds || []).includes(buildingId);
}

function inRoleScope(persona, resource) {
  const role = getRole(persona);
  if (!role) return false;
  if (role.scopeMode === "own") return resource.requesterId === persona.id;
  if (role.scopeMode === "assigned") return resource.assigneeId === persona.id;
  if (role.scopeMode === "subtree") {
    return isOrgInScope(role.scopeOrgId, resource.orgId, role.sensitiveGrants) && isBuildingInScope(persona, resource.buildingId);
  }
  return false;
}

export function canViewWorkOrder(persona, workOrder) {
  const role = getRole(persona);
  if (!role || role.aggregateOnly || !hasPermission(persona, "work_order:view")) return false;
  // Building-scoped contributors (RAs) can also follow requests they filed themselves.
  if (role.scopeMode === "subtree" && workOrder.requesterId === persona.id) return true;
  return inRoleScope(persona, workOrder);
}

export function canCreateWorkOrder(persona) {
  return hasPermission(persona, "work_order:create") && !getRole(persona)?.readOnly;
}

export function canUpdateWorkOrder(persona, workOrder) {
  const role = getRole(persona);
  if (!role || role.readOnly || !hasPermission(persona, "work_order:update")) return false;
  return inRoleScope(persona, workOrder);
}

export function canAssignWorkOrder(persona, workOrder) {
  const role = getRole(persona);
  if (!role || role.readOnly || !hasPermission(persona, "work_order:assign")) return false;
  return role.scopeMode === "subtree" && inRoleScope(persona, workOrder);
}

export function canViewAuditEvent(persona, event) {
  const role = getRole(persona);
  if (!role) return false;
  if (role.permissions.includes("audit:view:institution")) return true;
  if (role.permissions.includes("audit:view:department")) {
    return isOrgInScope(role.scopeOrgId, event.orgId, role.sensitiveGrants);
  }
  return false;
}

export function canViewFloorPlan(persona, building) {
  if (!building?.floors) return false;
  if (!hasPermission(persona, "floorplan:view")) {
    // Residents see the plan of the building they live in, without the occupancy layer.
    return hasPermission(persona, "floorplan:view:own") && persona.buildingId === building.id;
  }
  return isBuildingInScope(persona, building.id);
}

export function canViewOccupancy(persona, building) {
  return hasPermission(persona, "occupancy:view") && isBuildingInScope(persona, building.id);
}

export function filterWorkOrders(persona, workOrders) {
  return workOrders.filter((workOrder) => canViewWorkOrder(persona, workOrder));
}

export function redactWorkOrder(persona, workOrder) {
  const role = getRole(persona);
  const redacted = { ...workOrder };

  if (!hasPermission(persona, "resident:view_identity") && workOrder.requesterId !== persona.id) {
    redacted.requesterName = "Resident (identity minimized)";
  }

  if (!hasPermission(persona, "work_order:view_internal")) {
    delete redacted.internalNote;
  }

  if (role?.scopeMode === "own") {
    delete redacted.assigneeId;
  }

  return redacted;
}

export function permissionDecision(persona, action, resource) {
  const decisions = {
    "work_order:view": () => canViewWorkOrder(persona, resource),
    "work_order:update": () => canUpdateWorkOrder(persona, resource),
    "work_order:assign": () => canAssignWorkOrder(persona, resource),
    "work_order:create": () => canCreateWorkOrder(persona),
    "floorplan:view": () => canViewFloorPlan(persona, resource),
    "occupancy:view": () => canViewOccupancy(persona, resource)
  };

  const evaluator = decisions[action];
  if (!evaluator) return { allowed: false, reason: "No policy exists for this action (deny by default)." };

  const allowed = evaluator();
  return {
    allowed,
    reason: allowed
      ? "Role permission and resource scope both matched."
      : "The role, organization scope, building scope, sensitivity, ownership, or assignment rule did not match."
  };
}

// Routing: IT goes to the help desk; residence halls go to the nested Housing
// Maintenance team; a restricted unit keeps its own queue; everything else is Facilities.
export function routeWorkOrder(persona, category, building) {
  if (category === "IT support") return "it-help-desk";
  if (building?.type === "residence") return "housing-maintenance";
  const owner = building?.orgId ? getOrganization(building.orgId) : null;
  if (owner?.sensitive && getRole(persona)?.scopeOrgId === owner.id) return owner.id;
  return "facilities-management";
}

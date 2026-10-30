import test from "node:test";
import assert from "node:assert/strict";

import { buildings, initialWorkOrders } from "../data.js";
import { generateFloorPlan, modeledRoomState, roomsPerFloor } from "../floorplans.js";

const modeled = buildings.filter((building) => building.floors);

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("every map building has a unique id and map number", () => {
  assert.equal(new Set(buildings.map((b) => b.id)).size, buildings.length);
  assert.equal(new Set(buildings.map((b) => b.mapNo)).size, buildings.length);
});

test("plans are deterministic", () => {
  for (const building of modeled) {
    assert.deepEqual(generateFloorPlan(building, 1), generateFloorPlan(building, 1));
  }
});

test("space ids are unique and spaces never overlap", () => {
  for (const building of modeled) {
    for (let floor = 1; floor <= building.floors; floor += 1) {
      const { spaces, width, height } = generateFloorPlan(building, floor);
      assert.equal(new Set(spaces.map((s) => s.id)).size, spaces.length, `${building.id} floor ${floor}`);
      for (let i = 0; i < spaces.length; i += 1) {
        const a = spaces[i];
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height, `${building.id} ${a.id} out of bounds`);
        for (let j = i + 1; j < spaces.length; j += 1) {
          assert.equal(overlaps(a, spaces[j]), false, `${building.id} ${a.id} overlaps ${spaces[j].id}`);
        }
      }
    }
  }
});

test("residence plans provide roughly the published bed capacity", () => {
  for (const building of modeled.filter((b) => b.type === "residence" && b.capacity)) {
    let beds = 0;
    for (let floor = 1; floor <= building.floors; floor += 1) {
      for (const space of generateFloorPlan(building, floor).spaces) beds += modeledRoomState(building.id, space)?.beds || 0;
    }
    assert.ok(beds >= building.capacity * 0.8, `${building.id}: ${beds} beds for ${building.capacity}`);
    assert.ok(roomsPerFloor(building) > 0);
  }
});

test("every interior work order resolves to a space on some floor", () => {
  for (const order of initialWorkOrders.filter((o) => !/entrance/i.test(o.room))) {
    const building = buildings.find((b) => b.id === order.buildingId);
    const found = Array.from({ length: building.floors }, (_, i) => generateFloorPlan(building, i + 1)).some((plan) => plan.spaces.some((s) => s.id === order.room));
    assert.ok(found, `${order.id} → ${order.buildingId} ${order.room}`);
  }
});

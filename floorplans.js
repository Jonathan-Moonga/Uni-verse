// Procedural, deterministic floor plans. Layout type and room counts come from
// published capacity data; geometry is modeled, not surveyed.

const MARGIN = 16;
const STAIR_W = 54;
const CORRIDOR_H = 34;
const WING_GAP = 44;

const layouts = {
  traditional: { roomW: 56, roomH: 78, maxPerSide: 14 },
  suite: { roomW: 56, roomH: 78, maxPerSide: 14 },
  apartment: { roomW: 124, roomH: 104, maxPerSide: 8 },
  generic: { roomW: 92, roomH: 82, maxPerSide: 6 }
};

export function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function layoutType(building) {
  return building.type === "residence" ? building.layout || "traditional" : "generic";
}

export function roomsPerFloor(building) {
  const type = layoutType(building);
  const floors = building.floors || 1;
  const capacity = building.capacity || 0;
  if (type === "traditional") return Math.max(8, Math.ceil(capacity / 2 / floors));
  if (type === "suite") return Math.max(8, Math.ceil(capacity / 2 / floors / 2) * 2);
  if (type === "apartment") return Math.max(6, Math.round(capacity / 3.2 / floors));
  return floors === 1 ? 8 : 10;
}

export function roomId(floor, number) {
  return `${floor}${String(number).padStart(2, "0")}`;
}

function bedroomCount(buildingId, id) {
  return hash(`${buildingId}:${id}:beds`) % 3 === 0 ? 2 : 4;
}

function roomItems(building, floor, numbers) {
  const type = layoutType(building);
  const { roomW } = layouts[type];
  if (type === "apartment") {
    return numbers.map((n) => {
      const id = roomId(floor, n);
      return { id, label: id, kind: "unit", w: roomW, bedrooms: bedroomCount(building.id, id) };
    });
  }
  if (type === "generic") {
    return numbers.map((n) => ({ id: roomId(floor, n), label: roomId(floor, n), kind: n % 4 === 1 ? "classroom" : "office", w: roomW }));
  }
  const items = [];
  numbers.forEach((n, index) => {
    const id = roomId(floor, n);
    items.push({ id, label: id, kind: "room", w: roomW });
    // Suite-style halls share one bath between each pair of rooms.
    if (type === "suite" && index % 2 === 0 && numbers[index + 1] !== undefined) {
      items.push({ id: `BATH ${id}`, label: "Bath", kind: "bath", w: 24 });
    }
  });
  return items;
}

function sharedSpaces(building, floor, wingIndex) {
  const type = layoutType(building);
  const top = [];
  const bottom = [];
  if (wingIndex > 0) return { top, bottom };
  if (floor === 1) bottom.push({ id: "LOBBY", label: building.type === "residence" ? "Lobby / Desk" : "Lobby", kind: "lobby", w: 120 });
  else if (building.type === "residence") bottom.push({ id: `LOUNGE ${floor}`, label: "Lounge", kind: "lounge", w: 96 });
  if (building.type === "residence") {
    if (floor === 1) top.push({ id: "LAUNDRY", label: "Laundry", kind: "service", w: 64 });
    top.push({ id: `RA ${floor}`, label: "RA", kind: "staff", w: 48 });
  }
  if (type === "generic" || building.bath === "community") {
    top.push({ id: `RESTROOMS ${floor}`, label: building.bath === "community" ? "Comm. bath" : "Restrooms", kind: "bath", w: 70 });
  }
  if ((building.floors || 1) > 1 && building.bath !== "community") {
    bottom.push({ id: `ELEV ${floor}`, label: "Elev", kind: "service", w: 40 });
  }
  return { top, bottom };
}

function placeRow(items, x0, y, h, spaces) {
  let x = x0;
  for (const item of items) {
    spaces.push({ ...item, x, y, h });
    x += item.w;
  }
  return x - x0;
}

export function generateFloorPlan(building, floor) {
  const type = layoutType(building);
  const { roomH, maxPerSide } = layouts[type];
  const total = roomsPerFloor(building);
  const wingCount = Math.ceil(total / (maxPerSide * 2));
  const perWing = Math.ceil(total / wingCount);
  const spaces = [];
  let y = MARGIN;
  let width = 0;

  for (let wing = 0; wing < wingCount; wing += 1) {
    const numbers = [];
    for (let n = wing * perWing + 1; n <= Math.min(total, (wing + 1) * perWing); n += 1) numbers.push(n);
    // Odd numbers on the north side of the corridor, even on the south.
    const topRooms = roomItems(building, floor, numbers.filter((n) => n % 2 === 1));
    const bottomRooms = roomItems(building, floor, numbers.filter((n) => n % 2 === 0));
    const shared = sharedSpaces(building, floor, wing);
    const top = [...shared.top, ...topRooms];
    const bottom = [...bottomRooms.slice(0, Math.ceil(bottomRooms.length / 2)), ...shared.bottom, ...bottomRooms.slice(Math.ceil(bottomRooms.length / 2))];

    const wingHeight = roomH * 2 + CORRIDOR_H;
    const suffix = wingCount > 1 ? ` ${String.fromCharCode(65 + wing)}` : "";
    const innerX = MARGIN + STAIR_W;
    const topWidth = placeRow(top, innerX, y, roomH, spaces);
    const bottomWidth = placeRow(bottom, innerX, y + roomH + CORRIDOR_H, roomH, spaces);
    const innerW = Math.max(topWidth, bottomWidth);
    if (topWidth < innerW) spaces.push({ id: `MECH ${floor}${suffix} N`, label: "Mech", kind: "mech", x: innerX + topWidth, y, w: innerW - topWidth, h: roomH });
    if (bottomWidth < innerW) spaces.push({ id: `MECH ${floor}${suffix} S`, label: "Storage", kind: "mech", x: innerX + bottomWidth, y: y + roomH + CORRIDOR_H, w: innerW - bottomWidth, h: roomH });

    spaces.push({ id: `CORRIDOR ${floor}${suffix}`, label: `Corridor${suffix}`, kind: "corridor", x: innerX, y: y + roomH, w: innerW, h: CORRIDOR_H });
    spaces.push({ id: `STAIR ${floor}${suffix} W`, label: "Stair", kind: "stair", x: MARGIN, y, w: STAIR_W, h: wingHeight });
    spaces.push({ id: `STAIR ${floor}${suffix} E`, label: "Stair", kind: "stair", x: innerX + innerW, y, w: STAIR_W, h: wingHeight });

    width = Math.max(width, innerX + innerW + STAIR_W + MARGIN);
    y += wingHeight + WING_GAP;
  }

  return {
    buildingId: building.id,
    floor,
    layout: type,
    width,
    height: y - WING_GAP + MARGIN,
    spaces
  };
}

export function isBookableSpace(space) {
  return ["room", "unit"].includes(space.kind);
}

// Synthetic occupancy/readiness so the housing layer has something to show.
// Replace with the housing system of record during a pilot.
export function modeledRoomState(buildingId, space) {
  if (!isBookableSpace(space)) return null;
  const roll = hash(`${buildingId}:${space.id}`) % 100;
  const beds = space.kind === "unit" ? space.bedrooms : 2;
  const occupied = roll < 8 ? 0 : roll < 20 ? beds - 1 : beds;
  return {
    beds,
    occupied,
    readiness: roll < 4 ? "inspection" : roll < 8 ? "turnover" : "ready"
  };
}

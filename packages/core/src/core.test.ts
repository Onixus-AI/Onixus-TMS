import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookingProblems, canTransition, chassisFits, containerNumberProblem, containerRisk, demurrage, dispatchProblems,
  loadShapeProblems, perDiem, planLegs, statusFromLegs, streetTurnMatches, type DriverLike,
} from "./index.js";

const today = "2026-10-12";
const now = new Date("2026-10-12T15:00:00Z");
const cdlDriver: DriverLike = { status: "AVAILABLE", cdl_class: "A", license_expiry: "2028-01-01", medical_card_expiry: "2027-01-01", twic_expiry: "2027-06-01" };

test("ISO 6346: the standard example passes and a one-character typo fails", () => {
  assert.equal(containerNumberProblem("CSQU3054383"), null);
  assert.equal(containerNumberProblem("csqu 305438-3"), null);
  assert.match(containerNumberProblem("CSQU3054384")!, /check digit \(expected 3\)/);
  assert.match(containerNumberProblem("CSQ3054383")!, /not a container number/);
});

test("container fields are refused on other freight", () => {
  assert.deepEqual(loadShapeProblems({ equipment_type: "FLATBED", container_number: "CSQU3054383", last_free_day: "2026-10-12" }), ["container_number, last_free_day only apply to container loads"]);
  assert.deepEqual(loadShapeProblems({ equipment_type: "DRY_VAN", booking_number: "BK1" }), []);
});

test("booking needs the facts for each kind of load, including where the move goes", () => {
  const base = { customer_id: "c", pickup_location_id: "p", delivery_location_id: "d", rate: 650 };
  assert.deepEqual(bookingProblems({ ...base, equipment_type: "CONTAINER", direction: "IMPORT", container_size: "40", container_number: "CSQU3054383", terminal_id: "t" }), []);
  assert.deepEqual(bookingProblems({ ...base, equipment_type: "CONTAINER", direction: "IMPORT", container_size: "40", container_number: "CSQU3054383" }), ["To plan the move, add: terminal"]);
  assert.deepEqual(bookingProblems({ ...base, equipment_type: "CONTAINER", direction: "EXPORT", container_size: "40", terminal_id: "t" }), ["Missing booking number"]);
  assert.deepEqual(bookingProblems({ ...base, equipment_type: "BOX_TRUCK" }), ["Missing commodity, weight"]);
  assert.deepEqual(bookingProblems({ customer_id: "c", rate: 1, equipment_type: "BOX_TRUCK", commodity: "x", weight_lbs: 1 }), ["To plan the move, add: pickup location, delivery location"]);
  assert.deepEqual(bookingProblems({ ...base, equipment_type: "CONTAINER", direction: "IMPORT", container_size: "40", container_number: "CSQU3054383", terminal_id: "t", move_type: "IMPORT_PREPULL" }), ["To plan the move, add: yard"]);
  assert.match(bookingProblems({ ...base, equipment_type: "CONTAINER", direction: "IMPORT", container_size: "40", container_number: "CSQU3054383", terminal_id: "t", move_type: "EXPORT_LIVE" })[0], /import cannot make an export/);
});

test("moves become legs, and the load status follows the legs", () => {
  const live = planLegs({ move_type: "IMPORT_LIVE", terminal_id: "T", delivery_location_id: "C" });
  assert.deepEqual(live.map((l) => [l.cargo, l.from_terminal_id ?? l.from_location_id, l.to_terminal_id ?? l.to_location_id, l.live]), [["LOADED", "T", "C", true], ["EMPTY", "C", "T", false]]);
  const prepull = planLegs({ move_type: "IMPORT_PREPULL", terminal_id: "T", delivery_location_id: "C", yard_location_id: "Y", return_location_id: "DEPOT" });
  assert.deepEqual(prepull.map((l) => [l.from_terminal_id ?? l.from_location_id, l.to_terminal_id ?? l.to_location_id]), [["T", "Y"], ["Y", "C"], ["C", "DEPOT"]]);
  const exp = planLegs({ move_type: "EXPORT_DROP", terminal_id: "T", pickup_location_id: "S", empty_pickup_location_id: "DEPOT" });
  assert.deepEqual(exp.map((l) => [l.cargo, l.from_terminal_id ?? l.from_location_id, l.to_terminal_id ?? l.to_location_id, l.live]), [["EMPTY", "DEPOT", "S", false], ["LOADED", "S", "T", false]]);
  assert.equal(planLegs({ move_type: "IMPORT_LIVE", terminal_id: "T" }).length, 0, "no consignee, no plan");

  const st = (statuses: string[]) => prepull.map((l, i) => ({ ...l, status: statuses[i] as any }));
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["PLANNED", "PLANNED", "PLANNED"])), null);
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["ASSIGNED", "PLANNED", "PLANNED"])), "ASSIGNED");
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["AT_ORIGIN", "PLANNED", "PLANNED"])), "AT_PICKUP");
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["IN_TRANSIT", "PLANNED", "PLANNED"])), "PICKED_UP");
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["DONE", "PLANNED", "PLANNED"])), "IN_TRANSIT", "sitting at the yard");
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["DONE", "AT_DESTINATION", "PLANNED"])), "AT_DELIVERY");
  assert.equal(statusFromLegs("IMPORT_PREPULL", st(["DONE", "DONE", "PLANNED"])), "DELIVERED");
  // Export: the empty leg only dispatches the load; the loaded box in-gating delivers it.
  const ex = (a: string, b: string) => exp.map((l, i) => ({ ...l, status: [a, b][i] as any }));
  assert.equal(statusFromLegs("EXPORT_DROP", ex("IN_TRANSIT", "PLANNED")), "DISPATCHED");
  assert.equal(statusFromLegs("EXPORT_DROP", ex("DONE", "IN_TRANSIT")), "PICKED_UP");
  assert.equal(statusFromLegs("EXPORT_DROP", ex("DONE", "DONE")), "DELIVERED");
});

test("status moves follow the lifecycle", () => {
  assert.ok(canTransition("BOOKED", "ASSIGNED"));
  assert.ok(!canTransition("DRAFT", "DELIVERED"));
  assert.ok(!canTransition("CLOSED", "BOOKED"));
});

test("dispatch matches freight to the right truck, trailer and driver", () => {
  const tractor = { kind: "TRACTOR" as const, status: "AVAILABLE" };
  // Container on a tractor, pool chassis picked up at the terminal: fine.
  assert.deepEqual(dispatchProblems({ loads: [{ equipment_type: "CONTAINER", container_size: "40" }], truck: tractor, driver: cdlDriver, today }), []);
  // Container needs a TWIC card.
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "CONTAINER" }], truck: tractor, driver: { ...cdlDriver, twic_expiry: null }, today }).some((p) => /TWIC/.test(p)));
  // A 45' box will not sit on a 20/40 chassis.
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "CONTAINER", container_size: "45" }], truck: tractor, trailer: { kind: "CHASSIS", size: "20/40" }, driver: cdlDriver, today }).some((p) => /chassis does not take/.test(p)));
  // Flatbed needs a flatbed trailer.
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "FLATBED" }], truck: tractor, driver: cdlDriver, today }).some((p) => /needs a flatbed trailer/.test(p)));
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "DRY_VAN" }], truck: tractor, trailer: { kind: "FLATBED" }, driver: cdlDriver, today }).some((p) => /needs a dry van, not a flatbed/.test(p)));
  // A container load can't go on a box truck.
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "CONTAINER" }], truck: { kind: "BOX_TRUCK" }, driver: cdlDriver, today }).some((p) => /needs a tractor/.test(p)));
  // Cargo van load on a light box truck, non-CDL driver: fine.
  const plainDriver = { status: "AVAILABLE", license_expiry: "2028-01-01" };
  assert.deepEqual(dispatchProblems({ loads: [{ equipment_type: "CARGO_VAN", weight_lbs: 800 }], truck: { kind: "BOX_TRUCK", gvwr_lbs: 16_000, max_payload_lbs: 5_000 }, driver: plainDriver, today }), []);
  // Heavy box truck needs a class B CDL; over payload is refused.
  const heavy = dispatchProblems({ loads: [{ equipment_type: "BOX_TRUCK", weight_lbs: 12_000 }], truck: { kind: "BOX_TRUCK", gvwr_lbs: 33_000, max_payload_lbs: 10_000 }, driver: plainDriver, today });
  assert.ok(heavy.some((p) => /class B CDL/.test(p)) && heavy.some((p) => /over the 10,000 lbs payload/.test(p)));
  // Hazmat needs the endorsement; at most two containers per trip.
  assert.ok(dispatchProblems({ loads: [{ equipment_type: "DRY_VAN", hazmat: true }], truck: tractor, trailer: { kind: "DRY_VAN" }, driver: cdlDriver, today }).some((p) => /hazmat endorsement/.test(p)));
  assert.ok(dispatchProblems({ loads: Array(3).fill({ equipment_type: "CONTAINER" }), truck: tractor, driver: cdlDriver, today }).some((p) => /at most two/.test(p)));
  assert.ok(chassisFits("40/45", "45") && !chassisFits("20", "40"));
});

test("demurrage and per diem clocks", () => {
  const load = { equipment_type: "CONTAINER", last_free_day: "2026-10-09", demurrage_per_day: 275, per_diem_per_day: 150, per_diem_free_days: 4 };
  assert.deepEqual(demurrage(load, now), { days: 3, amount: 825 });
  assert.deepEqual(demurrage({ ...load, outgated_at: "2026-10-10T08:00:00Z" }, now), { days: 1, amount: 275 });
  assert.deepEqual(perDiem({ ...load, outgated_at: "2026-10-05T08:00:00Z" }, now), { days: 3, amount: 450, freeDaysLeft: 0 });
  assert.equal(containerRisk(load, now).level, "ACCRUING");
  assert.equal(containerRisk({ ...load, last_free_day: "2026-10-13" }, now).level, "URGENT");
  assert.equal(containerRisk({ ...load, last_free_day: "2026-10-14" }, now).level, "WATCH");
  assert.equal(containerRisk({ ...load, last_free_day: "2026-10-20" }, now).level, "NONE");
  assert.equal(containerRisk({ equipment_type: "CONTAINER", direction: "EXPORT", status: "DISPATCHED", cutoff_at: "2026-10-13T06:00:00Z" }, now).level, "URGENT");
  assert.equal(containerRisk({ ...load, equipment_type: "DRY_VAN" }, now).level, "NONE");
});

test("street turns pair a nearby empty import with an export on the same line", () => {
  const locations = new Map([["consignee", { lat: 40.53, lng: -74.35 }], ["shipper-near", { lat: 40.6, lng: -74.3 }], ["shipper-far", { lat: 39.95, lng: -75.16 }]]);
  const imp = { id: "i1", equipment_type: "CONTAINER", direction: "IMPORT", status: "DELIVERED", steamship_line_id: "msc", container_number: "CSQU3054383", container_size: "40", outgated_at: "2026-10-10T00:00:00Z", delivery_location_id: "consignee" };
  const near = { id: "e1", equipment_type: "CONTAINER", direction: "EXPORT", status: "BOOKED", steamship_line_id: "msc", container_size: "40", pickup_location_id: "shipper-near" };
  const far = { ...near, id: "e2", pickup_location_id: "shipper-far" };
  const otherLine = { ...near, id: "e3", steamship_line_id: "maersk" };
  const matches = streetTurnMatches([imp, far, otherLine, near], locations);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].exportLoadId, "e1");
  assert.ok(matches[0].miles < 10);
  assert.equal(streetTurnMatches([{ ...imp, empty_returned_at: "2026-10-11T00:00:00Z" }, near], locations).length, 0);
});

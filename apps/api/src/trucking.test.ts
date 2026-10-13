import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { judgeCarrier, memoryStore } from "@onixus/providers";
import { createApp, type Deps } from "./app.js";

const KEY = "test-key-0123456789abcdefghij";
const NOW = new Date("2026-10-12T15:00:00Z");
const ORG = "00000000-0000-4000-8000-000000000001";
// The platform key acting inside one test company.
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "x-org-id": ORG };

async function withApi(fn: (call: Call, store: ReturnType<typeof memoryStore>) => Promise<void>, deps: Deps = {}, env: Record<string, string> = {}) {
  const store = memoryStore({ organizations: [{ id: ORG, name: "Test Trucking" }] });
  const server = createApp({ TMS_API_KEY: KEY, ...env }, { store: () => store, now: () => NOW, ...deps }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body, headers = auth) => {
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call, store);
  } finally {
    server.close();
  }
}
type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

async function setup(call: Call) {
  const customer = (await call("POST", "/customers", { type: "SHIPPER", company_name: "Acme Imports" })).body.customer;
  const line = (await call("POST", "/customers", { type: "STEAMSHIP_LINE", company_name: "MSC", scac_code: "MSCU" })).body.customer;
  const port = (await call("POST", `/customers/${customer.id}/locations`, { label: "Port Newark", lat: 40.684, lng: -74.149 })).body.location;
  const dc = (await call("POST", `/customers/${customer.id}/locations`, { label: "Edison DC", state: "NJ", lat: 40.53, lng: -74.35 })).body.location;
  const exporter = (await call("POST", `/customers/${customer.id}/locations`, { label: "Woodbridge plant", lat: 40.56, lng: -74.29 })).body.location;
  const driver = (await call("POST", "/drivers", { name: "Dee", cdl_class: "A", license_expiry: "2028-01-01", medical_card_expiry: "2027-01-01", twic_expiry: "2027-06-01" })).body.driver;
  const tractor = (await call("POST", "/trucks", { truck_number: "T-1", kind: "TRACTOR" })).body.truck;
  const box = (await call("POST", "/trucks", { truck_number: "B-1", kind: "BOX_TRUCK", gvwr_lbs: 16000, max_payload_lbs: 6000 })).body.truck;
  const chassis = (await call("POST", "/trailers", { unit_number: "CH-1", kind: "CHASSIS", size: "20/40" })).body.trailer;
  return { customer, line, port, dc, exporter, driver, tractor, box, chassis };
}

test("an import container goes from booking to invoice, with its clocks", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const created = await call("POST", "/loads", {
      customer_id: s.customer.id, steamship_line_id: s.line.id, pickup_location_id: s.port.id, delivery_location_id: s.dc.id,
      rate: 650, direction: "IMPORT", container_number: "csqu 305438-3", container_size: "40", last_free_day: "2026-10-10",
    });
    assert.equal(created.status, 201);
    const load = created.body.load;
    assert.equal(load.equipment_type, "CONTAINER");
    assert.equal(load.container_number, "CSQU3054383");

    // Two days past the last free day: demurrage is accruing.
    const alerts = (await call("GET", "/containers/alerts")).body.alerts;
    assert.equal(alerts[0].risk.level, "ACCRUING");

    assert.equal((await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" })).status, 200);
    const trip = await call("POST", "/dispatch", { load_ids: [load.id], driver_id: s.driver.id, truck_id: s.tractor.id, trailer_id: s.chassis.id });
    assert.equal(trip.status, 201, JSON.stringify(trip.body));
    assert.equal((await call("GET", `/drivers?status=ON_TRIP`)).body.drivers.length, 1);

    const tripId = trip.body.trip.id;
    assert.equal((await call("POST", `/trips/${tripId}/status`, { status: "DISPATCHED" })).status, 200);
    for (const st of ["AT_PICKUP", "PICKED_UP", "AT_DELIVERY", "DELIVERED"]) {
      const r = await call("POST", `/loads/${load.id}/status`, { status: st });
      assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.body)}`);
    }
    const detail = (await call("GET", `/loads/${load.id}`)).body;
    assert.ok(detail.load.outgated_at, "picking up an import out-gates it");
    assert.equal(detail.charges.demurrage.days, 2);
    assert.equal(detail.events.length, 8, "created, booked, assigned, dispatched, at pickup, picked up, at delivery, delivered");

    assert.equal((await call("POST", `/trips/${tripId}/status`, { status: "COMPLETED" })).status, 200);
    assert.equal((await call("GET", `/trucks?status=AVAILABLE`)).body.trucks.length, 2, "trip completion frees the truck");

    const inv = await call("POST", `/loads/${load.id}/invoice`, { accessorials: [{ code: "CHASSIS", description: "Chassis, 1 day", amount: 45 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.invoice.amount, 650 + 45 + 2 * 275);
    assert.equal(inv.body.load.status, "INVOICED");
    assert.equal((await call("POST", `/loads/${load.id}/invoice`, {})).status, 409);
  });
});

test("dispatch refuses the wrong equipment and says why", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const base = { customer_id: s.customer.id, pickup_location_id: s.port.id, delivery_location_id: s.dc.id, rate: 400 };
    const container = (await call("POST", "/loads", { ...base, direction: "IMPORT", container_number: "CSQU3054383", container_size: "40" })).body.load;
    await call("POST", `/loads/${container.id}/status`, { status: "BOOKED" });
    const wrong = await call("POST", "/dispatch", { load_ids: [container.id], driver_id: s.driver.id, truck_id: s.box.id });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.problems.some((p: string) => /needs a tractor/.test(p)));

    // A box-truck load on the box truck, by a non-CDL driver: fine.
    const plain = (await call("POST", "/drivers", { name: "Sam", license_expiry: "2028-01-01" })).body.driver;
    const freight = (await call("POST", "/loads", { ...base, equipment_type: "BOX_TRUCK", commodity: "Furniture", weight_lbs: 3200, pallet_count: 6 })).body.load;
    assert.equal((await call("POST", `/loads/${freight.id}/status`, { status: "BOOKED" })).status, 200);
    assert.equal((await call("POST", "/dispatch", { load_ids: [freight.id], driver_id: plain.id, truck_id: s.box.id })).status, 201);
    // The same box truck is now busy.
    const again = (await call("POST", "/loads", { ...base, equipment_type: "CARGO_VAN", commodity: "Parts", weight_lbs: 300 })).body.load;
    await call("POST", `/loads/${again.id}/status`, { status: "BOOKED" });
    const busy = await call("POST", "/dispatch", { load_ids: [again.id], driver_id: plain.id, truck_id: s.box.id });
    assert.ok(busy.body.problems.some((p: string) => /Truck is on_trip/.test(p)));
  });
});

test("load rules: container fields stay on containers; booking needs the facts; lifecycle is enforced", async () => {
  await withApi(async (call) => {
    const bad = await call("POST", "/loads", { equipment_type: "FLATBED", container_number: "CSQU3054383" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.problems[0], /only apply to container loads/);
    assert.match((await call("POST", "/loads", { container_number: "CSQU3054384" })).body.problems[0], /check digit/);

    const flatbed = (await call("POST", "/loads", { equipment_type: "FLATBED", commodity: "Steel coils", securement: "chains" })).body.load;
    const booking = await call("POST", `/loads/${flatbed.id}/status`, { status: "BOOKED" });
    assert.equal(booking.status, 422);
    assert.deepEqual(booking.body.problems, ["Missing customer, pickup location, delivery location, rate, weight"]);
    assert.equal((await call("POST", `/loads/${flatbed.id}/status`, { status: "DELIVERED" })).status, 409);
    assert.equal((await call("POST", `/loads/${flatbed.id}/status`, { status: "ASSIGNED" })).status, 409, "assignment goes through dispatch");
  });
});

test("street turn: find, propose, approve", async () => {
  await withApi(async (call, store) => {
    const s = await setup(call);
    const imp = (await call("POST", "/loads", { steamship_line_id: s.line.id, direction: "IMPORT", container_number: "CSQU3054383", container_size: "40", delivery_location_id: s.dc.id })).body.load;
    const exp = (await call("POST", "/loads", { steamship_line_id: s.line.id, direction: "EXPORT", booking_number: "BK123", container_size: "40", pickup_location_id: s.exporter.id })).body.load;
    // Fast-forward: the import has been delivered and emptied, the export is booked.
    await store.update("loads", imp.id, { status: "DELIVERED", outgated_at: "2026-10-10T10:00:00Z" });
    await store.update("loads", exp.id, { status: "BOOKED" });

    const matches = (await call("GET", "/street-turns")).body.matches;
    assert.equal(matches.length, 1);
    assert.ok(matches[0].miles < 10);
    assert.equal((await call("POST", "/street-turns", { import_load_id: imp.id, export_load_id: exp.id })).status, 201);
    assert.equal((await call("GET", "/street-turns")).body.matches.length, 0, "a proposed pair is no longer offered");
    const ok = await call("POST", `/street-turns/${imp.id}/approve`);
    assert.equal(ok.body.export.container_number, "CSQU3054383");
    assert.ok(ok.body.import.empty_returned_at);
  });
});

test("port webhook: signed updates set the last free day; unsigned ones are refused", async () => {
  const secret = "port-secret-0123456789";
  await withApi(async (call) => {
    const load = (await call("POST", "/loads", { direction: "IMPORT", container_number: "CSQU3054383", container_size: "40" })).body.load;
    const body = JSON.stringify({ container_number: "CSQU3054383", available: true, last_free_day: "2026-10-15", holds: [] });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const json = { "content-type": "application/json" };
    assert.equal((await call("POST", "/webhooks/port", body, json)).status, 401);
    assert.equal((await call("POST", "/webhooks/port", body, { ...json, "x-onixus-timestamp": String(Number(ts) - 3600), "x-onixus-signature": sig })).status, 401, "stale timestamp");
    const ok = await call("POST", "/webhooks/port", body, { ...json, "x-onixus-timestamp": ts, "x-onixus-signature": sig });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.loads_updated, 1);
    assert.equal((await call("GET", `/loads/${load.id}`)).body.load.last_free_day, "2026-10-15");
  }, {}, { PORT_WEBHOOK_SECRET: secret });
});

test("FMCSA: a carrier's record decides compliance; missing fields never pass", async () => {
  assert.equal(judgeCarrier("1", { allowedToOperate: "Y", bipdInsuranceOnFile: "750", bipdInsuranceRequired: "750", safetyRating: "S" }).status, "VERIFIED");
  assert.equal(judgeCarrier("1", { allowedToOperate: "N", bipdInsuranceOnFile: "750" }).status, "BLOCKED");
  assert.equal(judgeCarrier("1", { allowedToOperate: "Y", bipdInsuranceOnFile: "0", bipdInsuranceRequired: "750" }).status, "BLOCKED");
  assert.equal(judgeCarrier("1", { allowedToOperate: "Y" }).status, "WARNING");
  assert.equal(judgeCarrier("1", null).status, "BLOCKED");

  const checkCarrier = async (dot: string) => judgeCarrier(dot, { allowedToOperate: "N", legalName: "Shady Freight" });
  await withApi(async (call) => {
    const broker = (await call("POST", "/customers", { type: "BROKER", company_name: "Shady Freight", dot_number: "123456" })).body.customer;
    const r = await call("POST", `/customers/${broker.id}/fmcsa-check`);
    assert.equal(r.body.status, "BLOCKED");
    assert.equal((await call("GET", `/customers/${broker.id}`)).body.customer.compliance_status, "BLOCKED");
    assert.equal((await call("POST", "/fmcsa/recheck", {})).body.checked, 0, "just checked, so not due");
  }, { checkCarrier });
});

test("quotes use the customer's own tariff first; GPS positions match trucks", async () => {
  const tracking = () => ({ name: "fake", positions: async () => [{ deviceId: "gps-1", name: "T-1", lat: 40.7, lng: -74.1, speedMph: 42, heading: 90, at: NOW.toISOString() }] });
  await withApi(async (call) => {
    const c = (await call("POST", "/customers", { type: "SHIPPER", company_name: "Acme" })).body.customer;
    const lane = { origin: "Port Newark", destination: "Edison, NJ", equipment_type: "CONTAINER", effective_from: "2026-01-01" };
    await call("POST", "/tariffs", { ...lane, base_rate: 600, fuel_surcharge: 20 });
    await call("POST", "/tariffs", { ...lane, customer_id: c.id, base_rate: 550, fuel_surcharge: 20 });
    assert.equal((await call("POST", "/quotes", { origin: "port newark", destination: "Edison, NJ" })).body.total, 720);
    assert.equal((await call("POST", "/quotes", { customer_id: c.id, origin: "Port Newark", destination: "Edison, NJ" })).body.total, 660);
    assert.equal((await call("POST", "/quotes", { origin: "Port Newark", destination: "Edison, NJ", equipment_type: "FLATBED" })).status, 404);

    await call("POST", "/trucks", { truck_number: "T-1", tracking_device_id: "gps-1" });
    const v = (await call("GET", "/tracking")).body.vehicles;
    assert.equal(v[0].truck.truck_number, "T-1");
  }, { tracking });
});

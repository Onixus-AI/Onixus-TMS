import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { memoryStore } from "@onixus/providers";
import { createApp, type Deps } from "./app.js";

const KEY = "test-key-0123456789abcdefghij";
const ORG = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-12T15:00:00Z");
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "x-org-id": ORG };

type Res = { status: number; body: any };
type Call = (method: string, path: string, body?: unknown) => Promise<Res>;

// What the AI hands back for a two-container delivery order.
const DO_JSON = {
  direction: "IMPORT", customer_name: "Blue Ocean Forwarding", customer_reference: "BO-7781",
  steamship_line_name: "Mediterranean Shipping Co", steamship_line_scac: "mscu", bill_of_lading: "MEDUNJ123456", booking_number: null,
  pickup_number: "PIN 55821", vessel: "MSC AURORA", voyage: "FA642W", vessel_eta: "2026-10-09", terminal_name: "APM Terminals Elizabeth",
  last_free_day: "2026-10-15", cutoff_at: null,
  site: { name: "Edison Furniture DC", address: "100 Raritan Center Pkwy", city: "Edison", state: "NJ", zip: "08837" },
  commodity: "Furniture", hazmat: false, notes: "Call 1 hr before",
  containers: [
    { container_number: "CSQU 305438-3", size: "40", type: "HC", weight_lbs: 38000, seal_number: "S1" },
    { container_number: "TGHU0026970", size: "40", type: "HC", weight_lbs: 41000, seal_number: "S2" },
  ],
};

async function withApi(fn: (call: Call, files: Record<string, Buffer>) => Promise<void>, deps: Deps = {}, env: Record<string, string> = {}) {
  const store = memoryStore({ organizations: [{ id: ORG, name: "Harbor Drayage" }] });
  const files: Record<string, Buffer> = {};
  const server = createApp({ TMS_API_KEY: KEY, ...env }, {
    store: () => store,
    now: () => NOW,
    files: () => ({
      uploadUrl: async (path) => ((files[path] = Buffer.from("%PDF-1.4 delivery order")), { path, token: "t", signedUrl: "x" }),
      downloadUrl: async (p) => `https://dl.test/${p}`,
      download: async (p) => files[p] ?? Buffer.from(""),
    }),
    readOrder: async (req) => {
      assert.ok(req.file || req.text, "the reader gets the document or the email");
      return structuredClone(DO_JSON);
    },
    ...deps,
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call, files);
  } finally {
    server.close();
  }
}

async function setup(call: Call) {
  const line = (await call("POST", "/customers", { type: "STEAMSHIP_LINE", company_name: "MSC", scac_code: "MSCU" })).body.customer;
  const terminal = (await call("POST", "/terminals", { name: "APM Terminals Elizabeth", code: "APM" })).body.terminal;
  const customer = (await call("POST", "/customers", { type: "FREIGHT_FORWARDER", company_name: "Blue Ocean Forwarding" })).body.customer;
  const consignee = (await call("POST", `/customers/${customer.id}/locations`, { label: "Edison DC", city: "Edison", state: "NJ", lat: 40.53, lng: -74.35 })).body.location;
  const shipper = (await call("POST", `/customers/${customer.id}/locations`, { label: "Woodbridge plant", city: "Woodbridge", state: "NJ", lat: 40.56, lng: -74.29 })).body.location;
  const yard = (await call("POST", "/locations", { kind: "YARD", label: "Our yard", city: "Newark", state: "NJ" })).body.location;
  const depot = (await call("POST", "/locations", { kind: "DEPOT", label: "Empty depot", city: "Port Newark", state: "NJ" })).body.location;
  const driver = (await call("POST", "/drivers", { name: "Dee", cdl_class: "A", license_expiry: "2028-01-01", medical_card_expiry: "2027-01-01", twic_expiry: "2027-06-01" })).body.driver;
  const tractor = (await call("POST", "/trucks", { truck_number: "T-1", kind: "TRACTOR" })).body.truck;
  return { line, terminal, customer, consignee, shipper, yard, depot, driver, tractor };
}

const containerLoad = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown>) => ({
  customer_id: s.customer.id, steamship_line_id: s.line.id, terminal_id: s.terminal.id, rate: 650, container_size: "40", ...extra,
});

async function runLeg(call: Call, legId: string) {
  let last: Res | null = null;
  for (let i = 0; i < 4; i++) {
    last = await call("POST", `/legs/${legId}/advance`);
    assert.equal(last.status, 200, JSON.stringify(last.body));
  }
  return last!.body;
}

test("a delivery order becomes one booked load per container, matched to what we already have", async () => {
  await withApi(async (call, files) => {
    const s = await setup(call);
    const up = await call("POST", "/delivery-orders/upload-url", { file_name: "DO MEDUNJ123456.pdf", content_type: "application/pdf" });
    assert.equal(up.status, 200);
    assert.ok(up.body.path.startsWith(`${ORG}/intake/`) && files[up.body.path]);

    assert.equal((await call("POST", "/delivery-orders/read", { path: "someone-else/intake/x.pdf" })).status, 400);
    const read = await call("POST", "/delivery-orders/read", { path: up.body.path });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const { order, containers, matches } = read.body;
    assert.equal(order.steamship_line_scac, "MSCU");
    assert.equal(order.last_free_day, "2026-10-15");
    assert.equal(matches.steamship_line_id, s.line.id, "matched by SCAC");
    assert.equal(matches.terminal_id, s.terminal.id, "matched by name");
    assert.equal(matches.customer_id, s.customer.id);
    assert.equal(containers[0].container_number, "CSQU3054383");
    assert.equal(containers[0].problem, null);
    assert.match(containers[1].problem, /check digit/, "a mistyped container number is flagged before it is used");

    const body = {
      direction: "IMPORT", rate: 725, path: up.body.path, customer_id: matches.customer_id, steamship_line_id: matches.steamship_line_id, terminal_id: matches.terminal_id,
      new_site: { name: "Edison Furniture DC", address: "100 Raritan Center Pkwy", city: "Edison", state: "nj", zip: "08837" },
      bill_of_lading: order.bill_of_lading, pickup_number: order.pickup_number, vessel: order.vessel, voyage: order.voyage, vessel_eta: order.vessel_eta,
      last_free_day: order.last_free_day, commodity: order.commodity, customer_reference: order.customer_reference,
      containers: containers.map(({ problem: _p, ...c }: any) => c),
    };
    assert.equal((await call("POST", "/delivery-orders", body)).status, 400, "the bad number must be fixed first");
    body.containers[1].container_number = "TGHU0026975"; // the dispatcher fixes the typo
    const made = await call("POST", "/delivery-orders", body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.problems, {});
    assert.equal(made.body.loads.length, 2, "one load per container");
    assert.equal(made.body.loads[0].delivery_location_id, made.body.loads[1].delivery_location_id, "one consignee site created, shared");
    const load = made.body.loads[0];
    assert.equal(load.status, "BOOKED");
    assert.equal(load.source, "DELIVERY_ORDER");
    assert.equal(load.vessel, "MSC AURORA");
    assert.equal(load.pickup_number, "PIN 55821");
    assert.equal(load.weight_lbs, 38000);
    const detail = (await call("GET", `/loads/${load.id}`)).body;
    assert.deepEqual(detail.legs.map((l: any) => [l.cargo, l.status]), [["LOADED", "PLANNED"], ["EMPTY", "PLANNED"]], "booked loads come with their legs planned");
    assert.equal(detail.legs[0].from_terminal_id, s.terminal.id);
  });
});

test("pasted email text works too", async () => {
  await withApi(async (call) => {
    await setup(call);
    const r = await call("POST", "/delivery-orders/read", { text: "Please deliver CSQU3054383 40HC from APM to Edison DC, LFD 10/15" });
    assert.equal(r.status, 200);
    assert.equal((await call("POST", "/delivery-orders/read", {})).status, 400);
  });
});

test("with OpenRouter selected, the delivery order goes to OpenRouter as a PDF with the JSON Schema", async () => {
  // A stand-in for OpenRouter's chat completions endpoint.
  const seen: any[] = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "google/gemini-2.5-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "```json\n" + JSON.stringify(DO_JSON) + "\n```" } }] }));
    });
  }).listen(0);
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/v1`;
  try {
    await withApi(async (call) => {
      await setup(call);
      const up = (await call("POST", "/delivery-orders/upload-url", { file_name: "do.pdf", content_type: "application/pdf" })).body;
      const r = await call("POST", "/delivery-orders/read", { path: up.path });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.containers[0].container_number, "CSQU3054383");
      const sent = seen[0];
      assert.equal(sent.url, "/api/v1/chat/completions");
      assert.equal(sent.auth, "Bearer or-test-key");
      assert.equal(sent.body.model, "google/gemini-2.5-flash");
      assert.equal(sent.body.response_format.type, "json_schema");
      assert.equal(sent.body.response_format.json_schema.strict, true);
      assert.deepEqual(sent.body.provider, { require_parameters: true });
      const parts = sent.body.messages[1].content;
      assert.equal(parts[0].type, "file");
      assert.match(parts[0].file.file_data, /^data:application\/pdf;base64,/);
    }, { readOrder: undefined }, { LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-test-key", OPENROUTER_BASE_URL: base });
  } finally {
    fake.close();
  }
});

test("drop and pick: the loaded leg and the empty go on different trips, in order", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const load = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "CSQU3054383", delivery_location_id: s.consignee.id, move_type: "IMPORT_DROP", return_location_id: s.depot.id }))).body.load;
    await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    const [drop, empty] = (await call("GET", `/loads/${load.id}`)).body.legs;
    assert.equal(drop.live, false);
    assert.equal(empty.to_location_id, s.depot.id, "the empty goes back to the depot named on the load");

    const outOfOrder = await call("POST", "/dispatch", { leg_ids: [empty.id], driver_id: s.driver.id, truck_id: s.tractor.id });
    assert.equal(outOfOrder.status, 409);
    assert.match(outOfOrder.body.problems[0], /comes after leg 1/);

    const t1 = (await call("POST", "/dispatch", { leg_ids: [drop.id], driver_id: s.driver.id, truck_id: s.tractor.id })).body.trip;
    await call("POST", `/trips/${t1.id}/status`, { status: "DISPATCHED" });
    const after = await runLeg(call, drop.id);
    assert.equal(after.load.status, "DELIVERED");
    assert.equal((await call("POST", `/trips/${t1.id}/status`, { status: "COMPLETED" })).status, 200, "the drop trip is done");

    // Days later the customer has unloaded: a second trip brings the empty back.
    const t2 = await call("POST", "/dispatch", { leg_ids: [empty.id], driver_id: s.driver.id, truck_id: s.tractor.id });
    assert.equal(t2.status, 201, JSON.stringify(t2.body));
    await call("POST", `/trips/${t2.body.trip.id}/status`, { status: "DISPATCHED" });
    const back = await runLeg(call, empty.id);
    assert.equal(back.load.status, "DELIVERED");
    assert.ok(back.load.empty_returned_at || (await call("GET", `/loads/${load.id}`)).body.load.empty_returned_at);
  });
});

test("prepull: terminal to our yard, then yard to the customer", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const load = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "CSQU3054383", delivery_location_id: s.consignee.id, move_type: "IMPORT_PREPULL" }))).body.load;
    const booking = await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    assert.equal(booking.status, 422);
    assert.deepEqual(booking.body.problems, ["To plan the move, add: yard"]);
    await call("PATCH", `/loads/${load.id}`, { yard_location_id: s.yard.id });
    await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    const legs = (await call("GET", `/loads/${load.id}`)).body.legs;
    assert.deepEqual(legs.map((l: any) => [l.cargo, l.to_terminal_id ?? l.to_location_id]), [["LOADED", s.yard.id], ["LOADED", s.consignee.id], ["EMPTY", s.terminal.id]]);
    const trip = (await call("POST", "/dispatch", { leg_ids: [legs[0].id], driver_id: s.driver.id, truck_id: s.tractor.id })).body.trip;
    await call("POST", `/trips/${trip.id}/status`, { status: "DISPATCHED" });
    const atYard = await runLeg(call, legs[0].id);
    assert.equal(atYard.load.status, "IN_TRANSIT", "out of the terminal, waiting at our yard");
    assert.ok(atYard.load.outgated_at, "demurrage stopped at the out-gate");
  });
});

test("export: the empty out starts per diem, the loaded in-gate stops it and delivers the load", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const load = (await call("POST", "/loads", containerLoad(s, { direction: "EXPORT", booking_number: "BK77812", pickup_location_id: s.shipper.id, cutoff_at: "2026-10-14T18:00:00Z" }))).body.load;
    await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    const trip = (await call("POST", "/dispatch", { load_ids: [load.id], driver_id: s.driver.id, truck_id: s.tractor.id })).body;
    const [emptyOut, loadedIn] = trip.legs;
    assert.deepEqual([emptyOut.cargo, emptyOut.from_terminal_id, emptyOut.to_location_id, emptyOut.live], ["EMPTY", s.terminal.id, s.shipper.id, true]);
    await call("POST", `/trips/${trip.trip.id}/status`, { status: "DISPATCHED" });
    const early = await call("POST", `/legs/${loadedIn.id}/advance`);
    assert.equal(early.status, 409, "the loaded leg can't start before the empty is at the shipper");
    assert.match(early.body.error, /Finish leg 1/);
    const loaded = await runLeg(call, emptyOut.id);
    assert.equal(loaded.load.status, "DISPATCHED", "the empty leg only gets the box to the shipper");
    assert.ok(loaded.load.outgated_at);
    const done = await runLeg(call, loadedIn.id);
    assert.equal(done.load.status, "DELIVERED");
    const detail = (await call("GET", `/loads/${load.id}`)).body;
    assert.ok(detail.load.ingated_at);
    assert.equal(detail.charges.perDiem.amount, 0);
    assert.equal(detail.charges.risk.level, "NONE", "in-gated before the cutoff: nothing to worry about");
  });
});

test("canceling a trip that hasn't rolled puts its legs and loads back to waiting", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const load = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "CSQU3054383", delivery_location_id: s.consignee.id }))).body.load;
    await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    const trip = (await call("POST", "/dispatch", { load_ids: [load.id], driver_id: s.driver.id, truck_id: s.tractor.id })).body.trip;
    assert.equal((await call("GET", `/loads/${load.id}`)).body.load.status, "ASSIGNED");
    assert.equal((await call("POST", `/trips/${trip.id}/status`, { status: "CANCELED" })).status, 200);
    const detail = (await call("GET", `/loads/${load.id}`)).body;
    assert.equal(detail.load.status, "BOOKED");
    assert.deepEqual(detail.legs.map((l: any) => [l.status, l.trip_id]), [["PLANNED", null], ["PLANNED", null]]);
    assert.equal((await call("GET", "/trucks?status=AVAILABLE")).body.trucks.length, 1);
  });
});

test("an approved street turn drops the import's trip back to port and sends the export's empty from the consignee", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    const imp = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "CSQU3054383", delivery_location_id: s.consignee.id, move_type: "IMPORT_DROP" }))).body.load;
    const exp = (await call("POST", "/loads", containerLoad(s, { direction: "EXPORT", booking_number: "BK1", pickup_location_id: s.shipper.id }))).body.load;
    await call("POST", `/loads/${imp.id}/status`, { status: "BOOKED" });
    await call("POST", `/loads/${exp.id}/status`, { status: "BOOKED" });
    const [drop] = (await call("GET", `/loads/${imp.id}`)).body.legs;
    const trip = (await call("POST", "/dispatch", { leg_ids: [drop.id], driver_id: s.driver.id, truck_id: s.tractor.id })).body.trip;
    await call("POST", `/trips/${trip.id}/status`, { status: "DISPATCHED" });
    await runLeg(call, drop.id);

    const matches = (await call("GET", "/street-turns")).body.matches;
    assert.equal(matches.length, 1, JSON.stringify(matches));
    await call("POST", "/street-turns", { import_load_id: imp.id, export_load_id: exp.id });
    assert.equal((await call("POST", `/street-turns/${imp.id}/approve`)).status, 200);
    const impLegs = (await call("GET", `/loads/${imp.id}`)).body.legs;
    assert.deepEqual(impLegs.map((l: any) => l.cargo), ["LOADED"], "no empty trip back to the port");
    const expLegs = (await call("GET", `/loads/${exp.id}`)).body.legs;
    assert.equal(expLegs[0].from_location_id, s.consignee.id, "the export's empty comes from the import's consignee");
    assert.equal((await call("GET", `/loads/${exp.id}`)).body.load.container_number, "CSQU3054383");
  });
});

test("dashboard numbers, the rate card, and invoices that carry the extras a move earned", async () => {
  await withApi(async (call) => {
    const s = await setup(call);
    // A live unload, overweight, driven today.
    const load = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "CSQU3054383", delivery_location_id: s.consignee.id, weight_lbs: 46_000 }))).body.load;
    await call("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    // A box sitting at the terminal two days past its last free day.
    const late = (await call("POST", "/loads", containerLoad(s, { direction: "IMPORT", container_number: "TGHU0026975", delivery_location_id: s.consignee.id, last_free_day: "2026-10-10" }))).body.load;
    await call("POST", `/loads/${late.id}/status`, { status: "BOOKED" });

    let o = (await call("GET", "/overview?days=7")).body;
    assert.equal(o.kpis.containers, 2);
    assert.deepEqual(o.kpis.at_risk, { amount: 550, containers: 1 });
    assert.equal(o.needs_truck.legs, 4);
    assert.equal(o.needs_truck.urgent, 2, "both legs of the late box are urgent");
    assert.equal(o.where.terminal, 2);
    assert.equal(o.attention[0].container_number, "TGHU0026975");
    assert.equal(o.attention[0].customer, "Blue Ocean Forwarding");
    assert.equal(o.series.length, 7);

    const legs = (await call("GET", `/loads/${load.id}`)).body.legs;
    const trip = (await call("POST", "/dispatch", { leg_ids: legs.map((l: any) => l.id), driver_id: s.driver.id, truck_id: s.tractor.id })).body.trip;
    await call("POST", `/trips/${trip.id}/status`, { status: "DISPATCHED" });
    for (const l of legs) await runLeg(call, l.id);

    o = (await call("GET", "/overview")).body;
    assert.equal(o.kpis.moves_today, 2);
    assert.deepEqual(o.series.at(-1), { date: "2026-10-12", loaded: 1, empty: 1 });
    assert.equal(o.kpis.ready_to_invoice.count, 1);
    assert.equal(o.kpis.containers, 1, "a returned empty is out of play");

    // Owners price the extras; the load shows what it has earned.
    assert.equal((await call("PUT", "/rate-card", { chassis_per_day: "x" })).status, 400);
    assert.equal((await call("PUT", "/rate-card", { chassis_per_day: 55 })).body.rate_card.chassis_per_day, 55);
    const extras = (await call("GET", `/loads/${load.id}`)).body.extras;
    assert.deepEqual(extras.map((e: any) => [e.code, e.amount]), [["CHASSIS", 55], ["OVERWEIGHT", 150]]);

    // The invoice carries them unless the dispatcher sends their own list.
    const inv = await call("POST", `/loads/${load.id}/invoice`, {});
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.deepEqual(inv.body.invoice.accessorials.map((l: any) => l.code), ["LINEHAUL", "CHASSIS", "OVERWEIGHT"]);
    assert.equal(inv.body.invoice.amount, 650 + 55 + 150);
  });
});

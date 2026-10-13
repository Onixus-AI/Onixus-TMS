import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { memoryStore } from "@onixus/providers";
import { createApp } from "./app.js";

const KEY = "test-key-0123456789abcdefghij";
const NOW = new Date("2026-10-12T15:00:00Z");

// Fake Supabase Auth: a token per person.
const people: Record<string, { id: string; email: string }> = {
  "tok-ann": { id: "11111111-1111-4111-8111-111111111111", email: "ann@acme.test" },
  "tok-dan": { id: "22222222-2222-4222-8222-222222222222", email: "dan@acme.test" },
  "tok-dee": { id: "33333333-3333-4333-8333-333333333333", email: "dee@acme.test" },
  "tok-bob": { id: "44444444-4444-4444-8444-444444444444", email: "bob@other.test" },
  "tok-sam": { id: "55555555-5555-4555-8555-555555555555", email: "sam@vanman.test" },
};

type Res = { status: number; body: any };
type As = (token: string) => (method: string, path: string, body?: unknown) => Promise<Res>;

async function withApi(fn: (as: As, extras: { invites: string[]; store: ReturnType<typeof memoryStore> }) => Promise<void>) {
  const store = memoryStore();
  const invites: string[] = [];
  const server = createApp({ TMS_API_KEY: KEY, WEB_ORIGIN: "https://app.test" }, {
    store: () => store,
    now: () => NOW,
    verifyUser: async (t) => people[t] ?? null,
    inviteUser: async (email) => (invites.push(email), "sent"),
    files: () => ({ uploadUrl: async (path) => ({ path, token: "tok", signedUrl: `https://storage.test/${path}` }), downloadUrl: async (p) => `https://dl.test/${p}` }),
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as: As = (token) => async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(as, { invites, store });
  } finally {
    server.close();
  }
}

test("sign up, start a company, and only then reach the office", async () => {
  await withApi(async (as) => {
    const ann = as("tok-ann");
    assert.equal((await as("tok-nobody")("GET", "/me")).status, 401);
    const me = await ann("GET", "/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.membership, null);
    assert.equal((await ann("GET", "/loads")).status, 403, "no company yet");

    const made = await ann("POST", "/onboarding", { company_name: "Acme Drayage", dot_number: "1234567" });
    assert.equal(made.status, 201);
    assert.equal(made.body.membership.role, "OWNER");
    assert.equal(made.body.organization.name, "Acme Drayage");
    assert.equal((await ann("POST", "/onboarding", { company_name: "Again" })).status, 409);
    assert.equal((await ann("GET", "/loads")).status, 200);
  });
});

test("one company never sees another's data", async () => {
  await withApi(async (as) => {
    const ann = as("tok-ann"), bob = as("tok-bob");
    await ann("POST", "/onboarding", { company_name: "Acme" });
    await bob("POST", "/onboarding", { company_name: "Other Freight" });
    const load = (await ann("POST", "/loads", { equipment_type: "DRY_VAN", commodity: "Paper", weight_lbs: 20000 })).body.load;
    const driver = (await ann("POST", "/drivers", { name: "Dee", license_expiry: "2028-01-01" })).body.driver;

    assert.equal((await bob("GET", "/loads")).body.loads.length, 0);
    assert.equal((await bob("GET", `/loads/${load.id}`)).status, 404);
    assert.equal((await bob("PATCH", `/loads/${load.id}`, { notes: "mine now" })).status, 404);
    assert.equal((await bob("POST", `/loads/${load.id}/status`, { status: "CANCELED" })).status, 404);
    assert.equal((await bob("GET", "/drivers")).body.drivers.length, 0);
    const truck = (await bob("POST", "/trucks", { truck_number: "B1", kind: "TRACTOR" })).body.truck;
    assert.equal((await bob("POST", "/dispatch", { load_ids: [load.id], driver_id: driver.id, truck_id: truck.id })).status, 404);
    // Even an explicit org_id in the body is ignored.
    const sneaky = (await bob("POST", "/customers", { type: "SHIPPER", company_name: "X", org_id: load.org_id })).body.customer;
    assert.notEqual(sneaky.org_id, load.org_id);
    assert.equal((await ann("GET", "/loads")).body.loads.length, 1);
  });
});

test("owners invite dispatchers and drivers; each role gets only its part", async () => {
  await withApi(async (as, { invites }) => {
    const ann = as("tok-ann");
    await ann("POST", "/onboarding", { company_name: "Acme" });
    const deeDriver = (await ann("POST", "/drivers", { name: "Dee", license_expiry: "2028-01-01" })).body.driver;

    assert.equal((await ann("POST", "/members/invitations", { email: "dee@acme.test", role: "DRIVER" })).status, 400, "a driver invite names the driver record");
    assert.equal((await ann("POST", "/members/invitations", { email: "Dan@Acme.test", role: "DISPATCHER" })).status, 201);
    assert.equal((await ann("POST", "/members/invitations", { email: "dee@acme.test", role: "DRIVER", driver_id: deeDriver.id })).status, 201);
    assert.equal((await ann("POST", "/members/invitations", { email: "dan@acme.test", role: "DRIVER", driver_id: deeDriver.id })).status, 409);
    assert.deepEqual(invites, ["dan@acme.test", "dee@acme.test"]);

    // First sign-in accepts the invitation.
    const dan = as("tok-dan"), dee = as("tok-dee");
    assert.equal((await dan("GET", "/me")).body.membership.role, "DISPATCHER");
    assert.equal((await dee("GET", "/me")).body.membership.driver_id, deeDriver.id);

    assert.equal((await dan("GET", "/loads")).status, 200, "dispatchers run the office");
    assert.equal((await dan("GET", "/members")).status, 403, "only owners manage the team");
    assert.equal((await dee("GET", "/loads")).status, 403, "drivers stay in the driver app");
    assert.equal((await dee("GET", "/driver/trips")).status, 200);
    assert.equal((await dan("GET", "/driver/trips")).status, 403, "a dispatcher without a driver record has no driver app");

    const team = (await ann("GET", "/members")).body;
    assert.equal(team.members.length, 3);
    assert.equal(team.invitations.length, 0);

    // The last owner cannot step down; a disabled member loses access.
    const annId = team.members.find((m: any) => m.role === "OWNER").id;
    assert.equal((await ann("PATCH", `/members/${annId}`, { role: "DISPATCHER" })).status, 409);
    const danId = team.members.find((m: any) => m.role === "DISPATCHER").id;
    assert.equal((await ann("PATCH", `/members/${danId}`, { disabled: true })).status, 200);
    assert.equal((await dan("GET", "/loads")).status, 403);
  });
});

test("platform tools need the platform key; the key needs a company for office work", async () => {
  await withApi(async (as) => {
    const ann = as("tok-ann");
    await ann("POST", "/onboarding", { company_name: "Acme" });
    assert.equal((await ann("GET", "/providers")).status, 403);
    assert.equal((await ann("POST", "/email/send", { to: "a@b.co", subject: "s", html: "x" })).status, 403);
    assert.equal((await ann("POST", "/llm/complete", { prompt: "hi" })).status, 403);
    assert.equal((await ann("POST", "/fmcsa/recheck", {})).status, 403);
    assert.equal((await ann("POST", "/terminals", { name: "APM" })).status, 403);
    assert.equal((await ann("GET", "/terminals")).status, 200, "everyone reads the shared terminal list");
    const platform = as(KEY);
    assert.equal((await platform("GET", "/providers")).status, 200);
    assert.equal((await platform("GET", "/loads")).status, 400, "name the company with X-Org-Id");
    assert.equal((await platform("GET", "/me")).status, 403);
  });
});

test("a driver runs their trip from the phone: start, statuses, check-in, proof of delivery, done", async () => {
  await withApi(async (as) => {
    const ann = as("tok-ann"), dee = as("tok-dee"), dan = as("tok-dan");
    await ann("POST", "/onboarding", { company_name: "Acme" });
    const customer = (await ann("POST", "/customers", { type: "SHIPPER", company_name: "Furniture Co" })).body.customer;
    const pickup = (await ann("POST", `/customers/${customer.id}/locations`, { label: "Warehouse", city: "Edison", state: "NJ" })).body.location;
    const drop = (await ann("POST", `/customers/${customer.id}/locations`, { label: "Store #12", city: "Newark", state: "NJ" })).body.location;
    const driver = (await ann("POST", "/drivers", { name: "Dee", license_expiry: "2028-01-01" })).body.driver;
    const other = (await ann("POST", "/drivers", { name: "Dan", license_expiry: "2028-01-01" })).body.driver;
    const box = (await ann("POST", "/trucks", { truck_number: "B-7", kind: "BOX_TRUCK", gvwr_lbs: 16000 })).body.truck;
    await ann("POST", "/members/invitations", { email: "dee@acme.test", role: "DRIVER", driver_id: driver.id });
    await ann("POST", "/members/invitations", { email: "dan@acme.test", role: "DRIVER", driver_id: other.id });
    await dee("GET", "/me");
    await dan("GET", "/me");

    const load = (await ann("POST", "/loads", { equipment_type: "BOX_TRUCK", customer_id: customer.id, pickup_location_id: pickup.id, delivery_location_id: drop.id, rate: 480, commodity: "Sofas", weight_lbs: 2400 })).body.load;
    await ann("POST", `/loads/${load.id}/status`, { status: "BOOKED" });
    const trip = (await ann("POST", "/dispatch", { load_ids: [load.id], driver_id: driver.id, truck_id: box.id })).body.trip;

    const mine = (await dee("GET", "/driver/trips")).body;
    assert.equal(mine.trips.length, 1);
    assert.equal(mine.trips[0].loads[0].pickup.label, "Warehouse");
    assert.equal(mine.truck.truck_number, "B-7");
    assert.equal((await dan("GET", "/driver/trips")).body.trips.length, 0, "other drivers don't see it");
    assert.equal((await dan("POST", `/driver/loads/${load.id}/status`, { status: "AT_PICKUP" })).status, 404);

    assert.equal((await dee("POST", `/driver/loads/${load.id}/status`, { status: "AT_PICKUP" })).status, 409, "start the trip first");
    assert.equal((await dee("POST", `/driver/trips/${trip.id}/start`)).status, 200);
    assert.equal((await dee("POST", `/driver/loads/${load.id}/status`, { status: "DELIVERED" })).status, 409, "no skipping ahead");
    for (const status of ["AT_PICKUP", "PICKED_UP", "AT_DELIVERY", "DELIVERED"]) {
      const r = await dee("POST", `/driver/loads/${load.id}/status`, { status });
      assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await dee("POST", `/driver/trips/${trip.id}/events`, { event_type: "CHECK_CALL", lat: 40.7, lng: -74.1 })).status, 201);

    // Proof of delivery: signed upload, then record it; the load moves to POD received.
    const up = await dee("POST", `/driver/loads/${load.id}/documents/upload-url`, { kind: "POD", file_name: "pod.jpg", content_type: "image/jpeg" });
    assert.equal(up.status, 200);
    assert.ok(up.body.path.startsWith(`${load.org_id}/${load.id}/pod-`));
    assert.equal((await dee("POST", `/driver/loads/${load.id}/documents`, { kind: "POD", path: `${load.org_id}/someone-else/x.jpg` })).status, 400);
    const rec = await dee("POST", `/driver/loads/${load.id}/documents`, { kind: "POD", path: up.body.path, file_name: "pod.jpg", content_type: "image/jpeg" });
    assert.equal(rec.status, 201);
    assert.equal(rec.body.load.status, "POD_RECEIVED");
    const docs = (await ann("GET", `/loads/${load.id}/documents`)).body.documents;
    assert.equal(docs.length, 1);
    assert.match(docs[0].url, /^https:\/\/dl\.test\//);
    assert.equal((await dee("POST", `/driver/loads/${load.id}/documents/upload-url`, { kind: "POD", file_name: "x.exe", content_type: "application/x-msdownload" })).status, 400);

    assert.equal((await dee("POST", `/driver/trips/${trip.id}/complete`)).status, 200);
    assert.equal((await ann("GET", "/trucks?status=AVAILABLE")).body.trucks.length, 1, "finishing the trip frees the truck");
  });
});

test("an owner-operator is a company of one who also drives", async () => {
  await withApi(async (as) => {
    const sam = as("tok-sam");
    assert.equal((await sam("POST", "/onboarding", { company_name: "Sam's Van Service", kind: "OWNER_OPERATOR" })).status, 400, "needs their name for the driver record");
    const made = (await sam("POST", "/onboarding", { company_name: "Sam's Van Service", kind: "OWNER_OPERATOR", your_name: "Sam Ortiz" })).body;
    assert.equal(made.organization.kind, "OWNER_OPERATOR");
    assert.ok(made.membership.driver_id);
    const drivers = (await sam("GET", "/drivers")).body.drivers;
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].name, "Sam Ortiz");

    const van = (await sam("POST", "/trucks", { truck_number: "V-1", kind: "CARGO_VAN", max_payload_lbs: 3000 })).body.truck;
    const load = (await sam("POST", "/loads", { equipment_type: "CARGO_VAN", commodity: "Parts", weight_lbs: 500, rate: 150, customer_id: (await sam("POST", "/customers", { type: "SHIPPER", company_name: "Parts Co" })).body.customer.id })).body.load;
    await sam("PATCH", `/loads/${load.id}`, { pickup_location_id: null });
    assert.equal((await sam("POST", "/dispatch", { load_ids: [load.id], driver_id: made.membership.driver_id, truck_id: van.id })).status, 409, "not booked yet");
    assert.equal((await sam("GET", "/driver/trips")).status, 200, "and has the driver app too");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { createHttpMortuaryClient, MortuaryError } from "./client";
import { MockMortuaryClient, sampleCaseId } from "./mock";
import { loadOperations } from "./operations";
import { BillingPreview, CustodyForm, DocumentChecklist, InternationalPanel, OperationsDashboard, RELEASE_ACKNOWLEDGEMENT } from "./ui";
import type { Checklist, InternationalView, Invoice, Quote } from "./types";

afterEach(() => cleanup());

const AS_OF = new Date("2026-10-22T14:00:00.000Z");

test("operations queues come from the contract-shaped sample and omit restricted names", async () => {
  const client = new MockMortuaryClient();
  const snapshot = await loadOperations(client, AS_OF);
  const counts = Object.fromEntries(snapshot.metrics.map((metric) => [metric.id, metric.count]));
  expect(counts).toEqual({
    active: 5,
    unassigned_pickups: 1,
    upcoming_transfers: 1,
    missing_documents: 1,
    past_window: 1,
    needs_approval: 1,
  });
  expect(JSON.stringify(snapshot)).not.toContain("Sample Restricted Name");
  expect(client.live).toBe(false);
});

test("the HTTP client reports an API failure and does not substitute sample cases", async () => {
  const client = createHttpMortuaryClient({
    baseUrl: "http://mortuary.test",
    token: async () => "token",
    fetchImpl: async () => new Response(JSON.stringify({ error: "Mortuary is not enabled", code: "MODULE_DISABLED", problems: ["Enable the module"] }), { status: 409 }),
  });
  await expect(client.listCases()).rejects.toBeInstanceOf(MortuaryError);
  await expect(client.listCases()).rejects.toThrow(/Sample records were not substituted|Mortuary is not enabled/);
  try {
    await client.listCases();
  } catch (error) {
    expect(error).toBeInstanceOf(MortuaryError);
    expect((error as MortuaryError).code).toBe("MODULE_DISABLED");
    expect((error as MortuaryError).problems).toEqual(["Enable the module"]);
  }
});

test("a network failure does not invent cases", async () => {
  const client = createHttpMortuaryClient({
    baseUrl: "http://mortuary.test",
    token: async () => "token",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await expect(client.getCase("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/Sample records were not substituted/);
});

test("a metric opens its queue", async () => {
  const user = userEvent.setup();
  const snapshot = await loadOperations(new MockMortuaryClient(), AS_OF);
  let opened = "";
  render(<OperationsDashboard snapshot={snapshot} onOpen={(queue) => { opened = queue; }} />);
  expect(screen.getByText(/does not use|Restricted case detail/i)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Needs staff approval/ }));
  expect(opened).toBe("needs_approval");
});

test("the checklist shows only the configured items and the contract notice", () => {
  const checklist: Checklist = {
    complete: false,
    notice: "Operational checklist configured by staff. It is not a statement of legal requirements.",
    items: [{ category: "TRANSIT_PERMIT", sources: ["SERVICE_TYPE"], state: "MISSING", document_ids: [] }],
  };
  render(<DocumentChecklist checklist={checklist} canReview={false} />);
  expect(screen.getByText(/not a statement of legal requirements/)).toBeTruthy();
  expect(screen.getByText(/transit permit/i)).toBeTruthy();
  expect(screen.queryByText(/death certificate/i)).toBeNull();
});

test("documents complete stays separate from clearance, and approval waits for the server", async () => {
  const user = userEvent.setup();
  const view: InternationalView = {
    record: { case_id: "44444444-4444-4444-8444-444444444444", origin_country: "US", destination_country: "GH", transit_countries: [], receiving_party: { name: "Accra Receiving Partners (sample)", role: "FUNERAL_HOME", country: "GH" }, carrier: { name: "Sample Air Cargo", booking_reference: "FLT-SAMPLE-418" }, release_status: "NOT_REQUESTED", version: 2 },
    requirements: [],
    milestones: [],
    readiness: { ready: true, problems: [] },
    legal_clearance: false,
  };
  let release: () => void = () => {};
  const pending = new Promise<{ release_status: string; legal_clearance: boolean; approved_at?: string | null }>((resolve) => { release = () => resolve({ release_status: "APPROVED", legal_clearance: false, approved_at: "2026-10-22T14:01:00.000Z" }); });
  render(<InternationalPanel checklistComplete view={view} canApprove onApprove={() => pending} />);
  expect(screen.getByRole("region", { name: "Documents complete" }).textContent).toMatch(/Documents complete/);
  expect(screen.getByRole("region", { name: "Cleared for transport" }).textContent).toMatch(/Not cleared for transport/);
  expect(screen.getByText(/Not legal clearance/)).toBeTruthy();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Approve release" }));
  expect(screen.getByText(/Clearance is unchanged until the record returns/)).toBeTruthy();
  expect(screen.queryByText(/Server recorded staff release/)).toBeNull();
  release();
  expect((await screen.findByRole("status")).textContent).toMatch(/Server recorded staff release/);
  expect(screen.getByRole("status").textContent).toMatch(/Not legal clearance/);
  expect(screen.getByRole("region", { name: "Cleared for transport" }).textContent).toMatch(/Cleared for transport\. Staff release/);
  expect(RELEASE_ACKNOWLEDGEMENT).toMatch(/not legal clearance/);
});

test("a failed identity check shows no receipt, and the retry shows the server event", async () => {
  const user = userEvent.setup();
  let calls = 0;
  let release: (value: { event: { id: string; seq: number; recorded_at: string; kind: string }; replayed: boolean } | "fail") => void = () => {};
  render(
    <CustodyForm
      legs={[{ id: "leg-1", case_id: "c", seq: 1, mode: "GROUND", status: "PLANNED", version: 1, from: { name: "A", facility_type: "HOSPITAL", country: "US" }, to: { name: "B", facility_type: "FUNERAL_HOME", country: "US" }, scheduled_departure_at: AS_OF.toISOString(), scheduled_arrival_at: AS_OF.toISOString() }]}
      expectedSeq={0}
      submit={() => new Promise((resolve, reject) => {
        calls += 1;
        release = (value) => (value === "fail" ? reject(new Error("The server did not record this. No receipt was issued.")) : resolve(value));
      })}
    />,
  );
  await user.type(screen.getByLabelText(/How was identification confirmed/), "Case tag MC-2408");
  const first = user.click(screen.getByRole("button", { name: "Record identity check" }));
  expect(await screen.findByText(/Nothing is recorded until the event returns/)).toBeTruthy();
  release("fail");
  await first;
  expect((await screen.findByRole("alert")).textContent).toMatch(/No receipt was issued/);
  expect(screen.queryByText(/Server recorded identity check/)).toBeNull();
  const second = user.click(screen.getByRole("button", { name: "Record identity check" }));
  expect(await screen.findByText(/Nothing is recorded until the event returns/)).toBeTruthy();
  release({ event: { id: "evt-1", seq: 1, recorded_at: "2026-10-22T14:01:00.000Z", kind: "IDENTITY_CHECK" }, replayed: false });
  await second;
  expect(await screen.findByText(/Server recorded identity check evt-1, sequence 1/)).toBeTruthy();
  expect(calls).toBe(2);
});

test("the quote preview says it was not sent and payment is not verified", () => {
  const quotes: Quote[] = [{ id: "q", case_id: sampleCaseId("MC-2410"), number: "Q1", status: "ISSUED", currency: "USD", valid_until: "2026-11-22", version: 1, subtotal_cents: 48500, lines: [{ category: "SERVICE", description: "Local transfer", quantity: 1, unit_cents: 48500, amount_cents: 48500 }] }];
  const invoices: Invoice[] = [{ id: "i", invoice_number: "MI-2026-000001", status: "ISSUED", currency: "USD", due_date: "2026-11-22", version: 1, subtotal_cents: 48500, lines: quotes[0].lines, payment: { status: "NOT_VERIFIED", provider: null, verified_at: null, notice: "Payment collection is not connected." } }];
  render(<BillingPreview quotes={quotes} invoices={invoices} organization="Harbor Sample Home" />);
  expect(screen.getByLabelText("Client-facing quote preview").textContent).toMatch(/Preview only/);
  expect(screen.getByText(/NOT_VERIFIED/)).toBeTruthy();
  expect(screen.getByText(/Payment collection is not connected/)).toBeTruthy();
});

describe("approval acknowledgement", () => {
  test("uses the contract sentence", () => {
    expect(RELEASE_ACKNOWLEDGEMENT).toBe("I have reviewed the documents and requirements for this case. This is an internal release decision, not legal clearance.");
  });
});

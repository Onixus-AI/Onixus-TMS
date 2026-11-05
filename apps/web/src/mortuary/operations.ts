import type { MortuaryClient } from "./client";
import type { BoardLeg, CaseStatus, Metric, MortuaryCase, OperationsSnapshot, QueueId } from "./types";

const ACTIVE: CaseStatus[] = ["INTAKE", "AWAITING_RELEASE", "READY_FOR_DISPATCH", "IN_TRANSIT", "ON_HOLD"];
const OPEN_LEG = new Set(["PLANNED", "ASSIGNED", "EN_ROUTE", "IN_CUSTODY"]);
const HOUR = 60 * 60 * 1000;

export const QUEUE_LABELS: Record<QueueId, { label: string; detail: string }> = {
  active: { label: "Active cases", detail: "Not delivered, closed, or canceled." },
  unassigned_pickups: { label: "Unassigned pickups", detail: "Planned ground legs with no driver." },
  upcoming_transfers: { label: "Upcoming transfers", detail: "Planned or assigned legs departing within 36 hours." },
  missing_documents: { label: "Missing documents", detail: "The configured checklist is not complete." },
  past_window: { label: "Past scheduled arrival", detail: "Open legs whose scheduled arrival has passed. The API has no delayed status." },
  needs_approval: { label: "Needs staff approval", detail: "International release is not approved. Document completion does not clear transport." },
};

export function isActive(status: CaseStatus): boolean {
  return ACTIVE.includes(status);
}

export function pastWindow(leg: BoardLeg, asOf: number): boolean {
  return OPEN_LEG.has(leg.status) && leg.status !== "PLANNED" && Date.parse(leg.scheduled_arrival_at) < asOf;
}

export async function loadOperations(client: MortuaryClient, asOf = new Date()): Promise<OperationsSnapshot> {
  const cases: MortuaryCase[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 4; page += 1) {
    const result = await client.listCases({ limit: 100, cursor });
    cases.push(...result.cases);
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  const from = new Date(asOf.getTime() - 24 * HOUR).toISOString();
  const to = new Date(asOf.getTime() + 36 * HOUR).toISOString();
  const legs = await client.dispatchBoard(from, to);
  const active = cases.filter((item) => isActive(item.status));
  const partial: string[] = [];

  const missing = new Set<string>();
  await Promise.all(active.map(async (item) => {
    try {
      const checklist = await client.checklist(item.id);
      if (!checklist.complete) missing.add(item.id);
    } catch (error) {
      partial.push(error instanceof Error ? error.message : "A checklist could not be loaded.");
    }
  }));

  const approval = new Set<string>();
  await Promise.all(active.filter((item) => item.international).map(async (item) => {
    try {
      const detail = await client.getCase(item.id);
      if (detail.summary.international && detail.summary.international.release_status !== "APPROVED") approval.add(item.id);
    } catch (error) {
      partial.push(error instanceof Error ? error.message : "An international summary could not be loaded.");
    }
  }));

  const now = asOf.getTime();
  const unassigned = new Set(legs.filter((leg) => leg.mode === "GROUND" && leg.status === "PLANNED" && !leg.driver_id).map((leg) => leg.case_id));
  const upcoming = new Set(legs.filter((leg) => (leg.status === "PLANNED" || leg.status === "ASSIGNED") && Date.parse(leg.scheduled_departure_at) >= now && Date.parse(leg.scheduled_departure_at) <= now + 36 * HOUR).map((leg) => leg.case_id));
  const delayed = new Set(legs.filter((leg) => pastWindow(leg, now)).map((leg) => leg.case_id));
  const activeIds = new Set(active.map((item) => item.id));

  const caseIdsByQueue: Record<QueueId, string[]> = {
    active: active.map((item) => item.id),
    unassigned_pickups: [...unassigned],
    upcoming_transfers: [...upcoming],
    missing_documents: [...missing],
    past_window: [...delayed],
    needs_approval: [...approval],
  };

  const byId = new Map(cases.map((item) => [item.id, item]));
  const attentionIds = [...new Set([...delayed, ...approval, ...missing])].filter((id) => activeIds.has(id)).slice(0, 5);
  const metrics: Metric[] = (Object.keys(QUEUE_LABELS) as QueueId[]).map((id) => ({
    id,
    label: QUEUE_LABELS[id].label,
    detail: QUEUE_LABELS[id].detail,
    count: caseIdsByQueue[id].length,
  }));

  return {
    asOf: asOf.toISOString(),
    metrics,
    attention: attentionIds.map((id) => {
      const item = byId.get(id);
      const reasons = [
        delayed.has(id) ? "A leg is past its scheduled arrival" : "",
        approval.has(id) ? "Staff release is not approved" : "",
        missing.has(id) ? "A configured checklist item is not approved" : "",
      ].filter(Boolean);
      return { caseId: id, caseNumber: item?.case_number ?? id, line: `${item?.requesting_organization.name ?? "Case"} · ${reasons.join(" · ")}` };
    }),
    caseIdsByQueue,
    partialError: partial[0] ?? null,
  };
}

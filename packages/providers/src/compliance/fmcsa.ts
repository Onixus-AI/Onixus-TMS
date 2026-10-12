import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError } from "../types.js";

// FMCSA QCMobile: the free government API behind SAFER. A web key comes
// from https://mobile.fmcsa.dot.gov/QCDevsite (Login.gov account).
export const FMCSA_VARS = ["FMCSA_WEB_KEY"] as const;

export type ComplianceStatus = "VERIFIED" | "WARNING" | "BLOCKED";
export type CarrierCheck = {
  dotNumber: string;
  legalName: string | null;
  status: ComplianceStatus;
  reasons: string[];
  /** The carrier object exactly as FMCSA returned it, kept as the audit record. */
  raw: Record<string, unknown>;
};

/**
 * Turn FMCSA's carrier record into a decision. A field that is absent is
 * treated as unknown (WARNING), never as passing: a silently missing key
 * must not read as a clean record.
 */
export function judgeCarrier(dotNumber: string, carrier: Record<string, unknown> | null | undefined): CarrierCheck {
  if (!carrier) return { dotNumber, legalName: null, status: "BLOCKED", reasons: ["No FMCSA record for this DOT number"], raw: {} };
  const reasons: string[] = [];
  let status: ComplianceStatus = "VERIFIED";
  const warn = (r: string) => {
    reasons.push(r);
    if (status === "VERIFIED") status = "WARNING";
  };
  const block = (r: string) => {
    reasons.push(r);
    status = "BLOCKED";
  };

  const allowed = carrier.allowedToOperate;
  if (allowed === "N") block("Not authorized to operate");
  else if (allowed !== "Y") warn("Operating authority unknown");
  if (carrier.oosDate) block(`Out of service since ${carrier.oosDate}`);

  const rating = String(carrier.safetyRating ?? "").toUpperCase();
  if (rating === "U") block("Unsatisfactory safety rating");
  else if (rating === "C") warn("Conditional safety rating");

  const onFile = Number(carrier.bipdInsuranceOnFile);
  const required = Number(carrier.bipdInsuranceRequired ?? carrier.bipdRequiredAmount);
  if (!Number.isFinite(onFile)) warn("Liability insurance on file is unknown");
  else if (Number.isFinite(required) && required > 0 && onFile < required) block(`Liability insurance on file (${onFile}) is below the required ${required}`);

  return { dotNumber, legalName: (carrier.legalName as string) ?? null, status, reasons, raw: carrier };
}

export function fmcsa(env: Env) {
  const { FMCSA_WEB_KEY } = requireVars(env, "FMCSA", [...FMCSA_VARS]);
  return {
    async checkCarrier(dotNumber: string): Promise<CarrierCheck> {
      const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(dotNumber)}?webKey=${encodeURIComponent(FMCSA_WEB_KEY)}`;
      const body = await fetchJson<{ content?: { carrier?: Record<string, unknown> } | null }>(url, {}, (s, b) => new ProviderError("FMCSA", s, b));
      return judgeCarrier(dotNumber, body.content?.carrier);
    },
  };
}

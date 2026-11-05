import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorText, type MortuaryClient } from "./client";
import { newRequestKey } from "./format";
import type { Checklist, DocumentRow } from "./types";
import { DocumentChecklist, ErrorBlock, human, LoadingBlock } from "./ui";

const categories = ["RELEASE_AUTHORIZATION", "DEATH_CERTIFICATE", "TRANSIT_PERMIT", "EMBALMING_CERTIFICATE", "NON_CONTAGION_CERTIFICATE", "CONSULAR_DOCUMENT", "DECEDENT_PASSPORT", "AIRWAY_BILL", "CARRIER_BOOKING", "CUSTODY_ACKNOWLEDGMENT", "IDENTIFICATION_RECORD", "INVOICE_SUPPORT", "OTHER"];
const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];

export function DocumentWorkspace({ caseId, client, canReview }: { caseId: string; client: MortuaryClient; canReview: boolean }) {
  const [data, setData] = useState<{ checklist: Checklist; documents: DocumentRow[] } | null>(null);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const pending = useRef<{ key: string; file: File; category: string; document?: DocumentRow } | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([client.checklist(caseId), client.documents(caseId)]).then(([checklist, documents]) => {
      if (active) { setData({ checklist, documents }); setError(""); }
    }, (reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [caseId, client, tick]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(""); setReceipt("");
    if (!pending.current) {
      const fields = new FormData(form);
      const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
      if (!file?.size || file.size > 26214400 || !allowed.includes(file.type)) {
        setError("Choose a PDF, JPEG, PNG, WebP or HEIC file no larger than 25 MB."); return;
      }
      pending.current = { key: newRequestKey(), file, category: String(fields.get("category")) };
    }
    setBusy(true); setStarted(true);
    try {
      const attempt = pending.current;
      const result = await client.createDocument(caseId, { request_key: attempt.key, category: attempt.category,
        file_name: attempt.file.name, content_type: attempt.file.type, size_bytes: attempt.file.size });
      attempt.document = result.document;
      if (result.upload) {
        await client.putUpload(result.upload, attempt.file, attempt.file.type);
        await client.markUploaded(caseId, result.document.id, result.document.version);
      } else if (result.document.status === "UPLOAD_PENDING") throw new Error("Storage did not provide an upload destination. Retry this upload.");
      setReceipt("Document received by the server. Staff review is a separate step.");
      pending.current = null; setStarted(false); form.reset(); setTick(n => n + 1);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <div className="m-stack">
    {error && <ErrorBlock message={error} onRetry={() => setTick(n => n + 1)} />}
    {receipt && <p role="status" className="m-ok">{receipt}</p>}
    {!data ? <LoadingBlock label="Loading documents" /> : <>
      <DocumentChecklist checklist={data.checklist} canReview={canReview} />
      <section className="m-panel m-stack"><h2>Upload a case document</h2>
        <p className="m-muted">Private case storage. A successful upload does not approve the document.</p>
        <form className="m-stack" onSubmit={upload}>
          <label>Document category<select name="category" disabled={started}>{categories.map(c => <option key={c} value={c}>{human(c)}</option>)}</select></label>
          <label>File<input name="file" type="file" required disabled={started} accept={allowed.join(",")} /></label>
          <button disabled={busy} type="submit">{busy ? "Uploading…" : started ? "Retry same upload" : "Upload document"}</button>
        </form>
      </section>
      {data.documents.map(doc => <DocumentReview key={doc.id} document={doc} caseId={caseId} client={client} canReview={canReview} onSaved={() => setTick(n => n + 1)} />)}
    </>}
  </div>;
}

function DocumentReview({ document, caseId, client, canReview, onSaved }: { document: DocumentRow; caseId: string; client: MortuaryClient; canReview: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setBusy(true); setError("");
    try {
      const result = await client.downloadDocument(caseId, document.id);
      const url = new URL(result.url);
      if (url.protocol !== "https:") throw new Error("Storage returned an invalid secure download link.");
      window.open(url.href, "_blank", "noopener,noreferrer");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const decision = String(fields.get("decision")) as "APPROVED" | "REJECTED";
    const note = String(fields.get("note") ?? "").trim();
    if (decision === "REJECTED" && !note) { setError("Explain why the document is rejected."); return; }
    setBusy(true); setError("");
    try {
      await client.reviewDocument(caseId, document.id, { expected_version: document.version, decision, ...(note ? { note } : {}) });
      onSaved();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <section className="m-panel m-stack"><h3>{human(document.category)}</h3><p>{human(document.status)}</p>
    {error && <ErrorBlock message={error} />}
    {canReview && document.status !== "UPLOAD_PENDING" && <button type="button" disabled={busy} onClick={download}>Open private document</button>}
    {canReview && document.status === "RECEIVED" && <form className="m-stack" onSubmit={review}>
      <label>Review decision<select name="decision"><option value="APPROVED">Approve</option><option value="REJECTED">Reject</option></select></label>
      <label>Review note<textarea name="note" maxLength={1000} /></label>
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Record review"}</button>
    </form>}
  </section>;
}

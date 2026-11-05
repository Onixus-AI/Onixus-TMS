import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentWorkspace } from "./documents";
import { MockMortuaryClient, sampleCaseId } from "./mock";
import type { DocumentRow } from "./types";

afterEach(cleanup);
const document: DocumentRow = { id: "doc-1", case_id: sampleCaseId("1"), category: "RELEASE_AUTHORIZATION", status: "UPLOAD_PENDING", file_name: "release.pdf", content_type: "application/pdf", size_bytes: 4, version: 1 };

test("failed storage upload keeps the same request key and never claims receipt before confirmation", async () => {
  const client = new MockMortuaryClient();
  const create = vi.spyOn(client, "createDocument").mockResolvedValue({ document, upload: { signed_url: "https://storage.test/upload", token: "test", expires_in_seconds: 60 }, replayed: false } as never);
  const put = vi.spyOn(client, "putUpload").mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValue(undefined);
  const confirm = vi.spyOn(client, "markUploaded").mockResolvedValue({ ...document, status: "RECEIVED", version: 2 });
  render(<DocumentWorkspace client={client} caseId={sampleCaseId("1")} canReview />);
  const user = userEvent.setup();
  await user.upload(await screen.findByLabelText("File"), new File(["test"], "release.pdf", { type: "application/pdf" }));
  fireEvent.submit(screen.getByRole("button", { name: "Upload document" }).closest("form")!);
  await screen.findByText("Storage unavailable");
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.queryByText(/Document received by the server/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry same upload" }));
  await screen.findByText(/Document received by the server/);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  expect(put).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledWith(sampleCaseId("1"), document.id, 1);
});

test("staff without restricted access do not get document review or download controls", async () => {
  const client = new MockMortuaryClient();
  vi.spyOn(client, "documents").mockResolvedValue([{ ...document, status: "RECEIVED" }]);
  render(<DocumentWorkspace client={client} caseId={sampleCaseId("1")} canReview={false} />);
  await screen.findByText("received");
  expect(screen.queryByRole("button", { name: "Record review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open private document" })).toBeNull();
});

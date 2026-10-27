import { appendFileSync } from "node:fs";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { respond } from "./lib/model.js";
import "./lib/fault.js";

export default defineAgent({
  modelContextWindowTokens: 1000000,
  model: mockModel(async (request) => {
    const latest = request.lastUserMessage ?? "";
    const record = (stage: string, extra: Record<string, unknown> = {}) => {
      if (process.env.FIXTURE_AUDIT)
        appendFileSync(
          process.env.FIXTURE_AUDIT,
          `${JSON.stringify({ stage, snapshotCount: request.userMessages.filter((text) => text.includes("ORIGINAL_CONTEXT_SENTINEL")).length, ...extra })}\n`,
        );
    };
    // Test-only messages add adversarial cases; ordinary opening/feedback uses the unchanged example responder.
    if (latest.startsWith("READ:")) {
      const { commissionId } = JSON.parse(latest.slice(5));
      const id = "fixture-owner-read";
      const prior = request.toolResults.find((value) => value.id === id);
      if (prior) {
        record("owner-read", { isError: prior.isError, output: prior.output });
        return "READ_COMPLETE";
      }
      return { toolCalls: [{ id, name: "commissioning__read", input: { commissionId } }] };
    }
    if (latest.startsWith("UNBOUND:") || latest.startsWith("BOUND:")) {
      const unbound = latest.startsWith("UNBOUND:");
      const { commissionId, questionId } = JSON.parse(latest.slice(unbound ? 8 : 6));
      const id = unbound ? "unbound-decide" : "bound-decide";
      const prior = request.toolResults.find((value) => value.id === id);
      if (prior) {
        record(unbound ? "unbound-result" : "bound-result", {
          isError: prior.isError,
          output: prior.output,
        });
        return "CONTROL_COMPLETE";
      }
      return {
        toolCalls: [
          {
            id,
            name: "commissioning__decide",
            input: {
              commissionId,
              eventId: id,
              target: "question",
              questionId,
              decision: { answer: unbound ? "unauthorized" : "bound authorized answer" },
            },
          },
        ],
      };
    }
    const opened = request.toolResults.find(
      (value) => value.id === `example-open:${request.userMessageCount}`,
    );
    if (latest.startsWith("OPEN") && opened)
      record("opened", { isError: opened.isError, output: opened.output });
    let packet: {
      commissionId?: string;
      eventId?: string;
      kind?: string;
      payload?: { question?: { text?: string } };
    };
    try {
      packet = JSON.parse(latest);
    } catch {
      return respond(request);
    }
    if (packet.commissionId && packet.eventId) {
      if (packet.kind === "question" && packet.payload?.question?.text === "FINAL_JSON_ONLY") {
        record("final-json-only", { commissionId: packet.commissionId, eventId: packet.eventId });
        return JSON.stringify({ decision: { answer: "This is only final text" } });
      }
      const decision = request.toolResults.find((value) => value.id === `decide:${packet.eventId}`);
      record(decision ? "decided" : "owner-notification", {
        commissionId: packet.commissionId,
        eventId: packet.eventId,
        kind: packet.kind,
        ...(decision ? { isError: decision.isError, output: decision.output } : {}),
      });
    }
    return respond(request);
  }),
});

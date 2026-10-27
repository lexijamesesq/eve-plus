import { appendFileSync } from "node:fs";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import "./lib/fault.js";

export default defineAgent({
  modelContextWindowTokens: 1000000,
  model: mockModel((request) => {
    const latest = request.lastUserMessage ?? "";
    const record = (stage: string, extra: Record<string, unknown> = {}) => {
      if (process.env.FIXTURE_AUDIT)
        appendFileSync(
          process.env.FIXTURE_AUDIT,
          `${JSON.stringify({ stage, snapshotCount: request.userMessages.filter((text) => text.includes("ORIGINAL_CONTEXT_SENTINEL")).length, ...extra })}\n`,
        );
    };
    if (latest.startsWith("UNBOUND:")) {
      const { commissionId, questionId } = JSON.parse(latest.slice(8));
      const result = request.toolResults.find((value) => value.id === "unbound-decide");
      if (!result)
        return {
          toolCalls: [
            {
              id: "unbound-decide",
              name: "commissioning__decide",
              input: {
                commissionId,
                eventId: "unbound-decision",
                target: "question",
                questionId,
                decision: { answer: "unauthorized" },
              },
            },
          ],
        };
      record("unbound-result", { isError: result.isError, output: result.output });
      return "UNBOUND_COMPLETE";
    }
    if (latest.startsWith("BOUND:")) {
      const { commissionId, questionId } = JSON.parse(latest.slice(6));
      const result = request.toolResults.find((value) => value.id === "bound-decide");
      if (!result)
        return {
          toolCalls: [
            {
              id: "bound-decide",
              name: "commissioning__decide",
              input: {
                commissionId,
                eventId: "bound-decision",
                target: "question",
                questionId,
                decision: { answer: "bound authorized answer" },
              },
            },
          ],
        };
      record("bound-result", { isError: result.isError, output: result.output });
      return "BOUND_COMPLETE";
    }
    if (latest.startsWith("OPEN ")) {
      const result = request.toolResults.find((value) => value.id === "open-commission");
      if (!result)
        return {
          toolCalls: [
            {
              id: "open-commission",
              name: "commissioning__open",
              input: {
                spec: {
                  brief: "Inspect the committed acceptance marker",
                  acceptance: ["acceptance.txt equals ready"],
                  privateGuidance: "Preserve original context",
                },
              },
            },
          ],
        };
      record("opened", { isError: result.isError, output: result.output });
      return JSON.stringify(result.output);
    }
    let packet: {
      commissionId: string;
      eventId: string;
      kind: string;
      payload: { questionId?: string; question?: { text?: string } };
    };
    try {
      packet = JSON.parse(latest);
    } catch {
      return "IDLE";
    }
    if (!packet.commissionId || !packet.eventId) return "IDLE";
    const callId = `decide:${packet.eventId}`;
    const prior = request.toolResults.find((value) => value.id === callId);
    if (prior) {
      record("decided", {
        commissionId: packet.commissionId,
        eventId: packet.eventId,
        isError: prior.isError,
        output: prior.output,
      });
      return "DECISION_RECORDED";
    }
    record("owner-notification", {
      commissionId: packet.commissionId,
      eventId: packet.eventId,
      kind: packet.kind,
    });
    if (packet.kind === "question" && packet.payload.question?.text === "FINAL_JSON_ONLY") {
      record("final-json-only", { commissionId: packet.commissionId, eventId: packet.eventId });
      return JSON.stringify({
        target: "question",
        questionId: packet.payload.questionId,
        decision: { answer: "This is only text" },
      });
    }
    if (packet.kind === "question")
      return {
        toolCalls: [
          {
            id: callId,
            name: "commissioning__decide",
            input: {
              commissionId: packet.commissionId,
              eventId: `answer:${packet.eventId}`,
              target: "question",
              questionId: packet.payload.questionId,
              decision: { answer: "authorized answer" },
            },
          },
        ],
      };
    if (packet.kind === "proposal") {
      const inspected = request.toolResults.find(
        (value) => value.id === `inspect:${packet.eventId}`,
      );
      if (!inspected)
        return {
          toolCalls: [
            {
              id: `inspect:${packet.eventId}`,
              name: "inspect",
              input: { commissionId: packet.commissionId },
            },
          ],
        };
      const evidence = inspected.output as { proposalId: string; pass: boolean };
      return {
        toolCalls: [
          {
            id: callId,
            name: "commissioning__decide",
            input: {
              commissionId: packet.commissionId,
              eventId: `verdict:${packet.eventId}`,
              target: "proposal",
              proposalId: evidence.proposalId,
              decision: {
                verdict: evidence.pass ? "accept" : "revise",
                feedback: evidence.pass
                  ? "Verified committed acceptance marker"
                  : "Committed acceptance marker is missing",
              },
            },
          },
        ],
      };
    }
    return "ATTENTION_RECORDED";
  }),
});

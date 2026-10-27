import type { MockModelResponder } from "eve/evals";

// A deterministic teaching model. Real applications choose their own model and policy.
export const respond: MockModelResponder = (request) => {
  const input = request.lastUserMessage ?? "";
  if (input.startsWith("OPEN")) {
    const openCallId = `example-open:${request.userMessageCount}`;
    const prior = request.toolResults.find((result) => result.id === openCallId);
    if (prior) return JSON.stringify(prior.output);
    const reference = input.split(/\s+/)[1];
    return {
      toolCalls: [
        {
          id: openCallId,
          name: "commissioning__open",
          input: {
            spec: {
              brief: "Implement the committed acceptance marker",
              acceptance: ["acceptance.txt equals ready"],
              privateGuidance: "Private commissioner discussion",
            },
            ...(process.env.EXAMPLE_WORKER_MODE === "neutral"
              ? {}
              : { workReference: { kind: "linear-issue", id: reference ?? "ENG-123" } }),
          },
        },
      ],
    };
  }
  let packet: {
    commissionId: string;
    eventId: string;
    kind: string;
    payload: { questionId?: string };
  };
  try {
    packet = JSON.parse(input);
  } catch {
    return "Send OPEN ENG-123 to commission the example work.";
  }
  if (!packet.commissionId || !packet.eventId) return "IDLE";
  const decisionId = `decide:${packet.eventId}`;
  if (request.toolResults.some((result) => result.id === decisionId)) return "DECISION_RECORDED";
  const readId = `read:${packet.eventId}`;
  if (!request.toolResults.some((result) => result.id === readId))
    return {
      toolCalls: [
        {
          id: readId,
          name: "commissioning__read",
          input: { commissionId: packet.commissionId },
        },
      ],
    };
  if (packet.kind === "question")
    return {
      toolCalls: [
        {
          id: decisionId,
          name: "commissioning__decide",
          input: {
            commissionId: packet.commissionId,
            eventId: `answer:${packet.eventId}`,
            target: "question",
            questionId: packet.payload.questionId,
            decision: { answer: "Use the recorded acceptance criteria" },
          },
        },
      ],
    };
  if (packet.kind === "proposal") {
    const inspectId = `inspect:${packet.eventId}`;
    const inspection = request.toolResults.find((result) => result.id === inspectId);
    if (!inspection)
      return {
        toolCalls: [
          { id: inspectId, name: "inspect", input: { commissionId: packet.commissionId } },
        ],
      };
    if (inspection.isError) return "Artifact inspection failed; owner review is required.";
    const evidence = inspection.output as { proposalId: string; pass: boolean };
    return {
      toolCalls: [
        {
          id: decisionId,
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
};

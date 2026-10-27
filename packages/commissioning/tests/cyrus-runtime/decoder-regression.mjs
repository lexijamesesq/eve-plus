import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasRecoveredCommissionerAnswer } from "../cyrus-runtime-proof.mjs";

// Sanitized values with the exact envelope and appended metadata observed from SDK 0.3.281.
const fixture = JSON.parse(
  await readFile(new URL("./sdk-read-result.json", import.meta.url), "utf8"),
);
const commissionId = fixture.envelope.result.commissionId;
const messages = (
  content,
  {
    callId = "read-1",
    resultId = "read-1",
    tool = "mcp__commissioner__commission_read",
    target = commissionId,
  } = {},
) => [
  {
    role: "assistant",
    content: [{ type: "tool_use", id: callId, name: tool, input: { commissionId: target } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content }] },
];
const plain = JSON.stringify(fixture.envelope);
const observed = plain + fixture.metadataSuffix;
assert.equal(hasRecoveredCommissionerAnswer(messages(plain), commissionId), true);
assert.equal(hasRecoveredCommissionerAnswer(messages(observed), commissionId), true);
for (const options of [
  { resultId: "unrelated-call" },
  { tool: "mcp__other__commission_read" },
  { target: "foreign-commission" },
])
  assert.equal(hasRecoveredCommissionerAnswer(messages(observed, options), commissionId), false);
const foreign = structuredClone(fixture.envelope);
foreign.result.commissionId = "foreign-commission";
assert.equal(
  hasRecoveredCommissionerAnswer(
    messages(JSON.stringify(foreign) + fixture.metadataSuffix),
    commissionId,
  ),
  false,
);
assert.equal(
  hasRecoveredCommissionerAnswer(messages(`${observed}extra trailing payload`), commissionId),
  false,
);
for (const change of [
  { questionId: "another-question" },
  { status: "pending" },
  { answer: { answer: "Unrecorded prose" } },
]) {
  const changed = structuredClone(fixture.envelope);
  Object.assign(changed.result.questions[0], change);
  assert.equal(
    hasRecoveredCommissionerAnswer(
      messages(JSON.stringify(changed) + fixture.metadataSuffix),
      commissionId,
    ),
    false,
  );
}
console.log(
  JSON.stringify({
    passed: true,
    agentRuntimeStarted: false,
    actualSdkShape: "0.3.281 JSON envelope plus trailing total_tokens reminder",
    plainJsonPositive: true,
    observedMetadataPositive: true,
    unrelatedToolAndTargetNegatives: true,
    malformedOrExtraPayloadNegatives: true,
  }),
);

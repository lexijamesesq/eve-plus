import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
export function verifyNativeStream(text) {
  const events = text.trim().split("\n").filter(Boolean).map(JSON.parse);
  const targets = ["question:overlap-a", "question:overlap-b"].map((eventId) => {
    const message = events.find((event) => {
      if (event.type !== "message.received") return false;
      try {
        return JSON.parse(event.data.message).eventId === eventId;
      } catch {
        return false;
      }
    });
    assert.ok(message, `Missing native message ${eventId}`);
    const turnId = message.data.turnId;
    const start = events.findIndex(
      (event) => event.type === "turn.started" && event.data.turnId === turnId,
    );
    const end = events.findIndex(
      (event) => event.type === "turn.completed" && event.data.turnId === turnId,
    );
    assert.ok(start >= 0 && end > start, "Native turn must complete");
    return { eventId, turnId, start, end };
  });
  targets.sort((a, b) => a.start - b.start);
  assert.notEqual(targets[0].turnId, targets[1].turnId);
  assert.ok(
    targets[0].end < targets[1].start,
    "Native queue must complete one turn before starting the next",
  );
  const imports = events.filter((event) => event.type === "history.imported");
  assert.equal(imports.length, 1, "Original context may be seeded only once");
  assert.equal(
    imports[0].data.messages.filter((message) => message.text.includes("ORIGINAL_CONTEXT_SENTINEL"))
      .length,
    1,
  );
  return {
    passed: true,
    serialized: true,
    originalHistoryImportedOnce: true,
    turns: targets.map(({ eventId, turnId }) => ({ eventId, turnId })),
  };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  console.log(JSON.stringify(verifyNativeStream(await readFile(process.argv[2], "utf8")), null, 2));

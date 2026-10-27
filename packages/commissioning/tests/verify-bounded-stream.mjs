import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readNativeStream } from "./read-native-stream.mjs";

assert.ok(
  process.argv[2] && process.argv[3] && process.argv[4],
  "Usage: verify-bounded-stream.mjs <installed-consumer> <safe-recorded-stream> <result.json>",
);
const requireConsumer = createRequire(join(resolve(process.argv[2]), "package.json"));
const { Client } = await import(pathToFileURL(requireConsumer.resolve("eve/client")).href);
const recorded = (await readFile(process.argv[3], "utf8")).trim().split("\n").map(JSON.parse);
const event = recorded.find((item) => item.type === "message.completed");
assert.ok(event, "Use a captured safe native message.completed event");
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const mode = url.pathname.includes("timeout-case")
    ? "timeout"
    : url.pathname.includes("empty-case")
      ? "empty"
      : "tail";
  const record = {
    mode,
    includeTailIndex: url.searchParams.get("includeTailIndex"),
    follow: url.searchParams.get("follow"),
    closed: false,
  };
  requests.push(record);
  if (
    request.headers.authorization !==
    `Basic ${Buffer.from("example-commissioner:bounded-fixture-only").toString("base64")}`
  ) {
    response.writeHead(401);
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-eve-stream-version": "26",
    "x-eve-stream-tail-index": mode === "empty" ? "-1" : mode === "timeout" ? "1" : "0",
  });
  response.flushHeaders();
  if (mode !== "empty") response.write(`${JSON.stringify(event)}\n`);
  // Deliberately never end the HTTP body: the public SDK must stop at the tail or deadline.
  response.on("close", () => {
    record.closed = true;
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const client = new Client({
  host: `http://127.0.0.1:${server.address().port}`,
  auth: { basic: { username: "example-commissioner", password: "bounded-fixture-only" } },
});
try {
  const prefix = await readNativeStream(client, "tail-case", 2000);
  assert.deepEqual(prefix.trim().split("\n").map(JSON.parse), [event]);
  const empty = await readNativeStream(client, "empty-case", 2000);
  assert.equal(empty, "");
  await assert.rejects(
    () => readNativeStream(client, "timeout-case", 250),
    "A body missing its announced tail must fail instead of returning a partial capture",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests.length, 3);
  assert.ok(
    requests.every(
      (item) => item.includeTailIndex === "1" && item.follow === "false" && item.closed,
    ),
  );
  const result = {
    passed: true,
    eve: "0.83.2",
    actualPublicClient: true,
    recordedEventPreserved: true,
    neverClosingBodyStopsAtDurableTail: true,
    emptyTailReturns: true,
    deadlineRejectsPartialPrefix: true,
    allConnectionsClosed: true,
    requests,
    agentRuntimeStarted: false,
    limits:
      "Isolated unrelated HTTP fixture using a captured safe event; no agent/model/work-service request and no alteration of native8PASS evidence",
  };
  await writeFile(process.argv[4], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

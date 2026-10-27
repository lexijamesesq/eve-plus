/** Read one durable stream prefix through the public eve/client session API. */
export async function readNativeStream(client, sessionId, timeoutMs = 45000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const events = [];
  for await (const event of client.sessions.attach(sessionId).stream({
    startIndex: 0,
    follow: false,
    signal,
  }))
    events.push(event);
  // The SDK may finish iteration on abort: a timed-out prefix must never look complete.
  signal.throwIfAborted();
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

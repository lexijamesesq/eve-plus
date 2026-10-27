import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const commissionId = process.argv[2];
if (!commissionId || !process.env.EXAMPLE_MCP_ENDPOINT || !process.env.EXAMPLE_WORKER_TOKEN)
  throw new Error("Supply commission ID, EXAMPLE_MCP_ENDPOINT and EXAMPLE_WORKER_TOKEN");
const client = new Client({ name: "commissioning-example-worker", version: "1" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(process.env.EXAMPLE_MCP_ENDPOINT), {
      requestInit: { headers: { authorization: `Bearer ${process.env.EXAMPLE_WORKER_TOKEN}` } },
    }),
  );
  console.log(
    JSON.stringify(
      await client.callTool({ name: "commission_read", arguments: { commissionId } }),
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

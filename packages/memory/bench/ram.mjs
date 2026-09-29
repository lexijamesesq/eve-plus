// Does recall/relate RAM grow with graph size on the current store? Grows the store to each target triple count via
// remember(), then measures RSS across a fixed batch of recall and relate queries. Zero model calls.
// Run after a build: node --expose-gc bench/ram.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGraph } from "../dist/memory-graph.js";

const dir = mkdtempSync(join(tmpdir(), "ram-bench-"));
const g = await MemoryGraph.create({ dir });
const count = () =>
  /** @type {{ n: number }} */ (g.db.prepare("select count(*) n from triples").get()).n;
const words = [
  "alpha",
  "harbor",
  "cedar",
  "quartz",
  "meadow",
  "copper",
  "ember",
  "violet",
  "summit",
  "lantern",
];
let i = 0;
async function growTo(target) {
  while (count() < target) {
    for (let k = 0; k < 500; k++, i++) {
      await g.remember({
        type: "Person",
        label: `Person ${i} ${words[i % 10]}`,
        attributes: {
          note: `${words[(i * 7) % 10]} ${words[(i * 3) % 10]} ${i}`,
          city: words[(i * 5) % 10],
        },
        relations:
          i > 0 ? [{ relation: "knows", to: `Person ${i - 1} ${words[(i - 1) % 10]}` }] : [],
      });
    }
  }
}
const mb = (b) => Math.round(b / 1048576);
async function measure(label) {
  if (!global.gc) throw new Error("run with node --expose-gc");
  global.gc();
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let q = 0; q < 200; q++) {
    g.recall(`${words[q % 10]} ${words[(q + 3) % 10]}`);
    g.relate(`Person ${(q * 97) % i} ${words[((q * 97) % i) % 10]}`);
    if (q % 10 === 0) peak = Math.max(peak, process.memoryUsage().rss);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(
    `${label}: triples=${count()} rss_base=${mb(base)}MB peak_during_queries=${mb(peak)}MB delta=${mb(peak - base)}MB`,
  );
}
for (const target of [10_000, 100_000]) {
  await growTo(target);
  await measure(`~${target / 1000}k`);
}
g.close();
rmSync(dir, { recursive: true, force: true });

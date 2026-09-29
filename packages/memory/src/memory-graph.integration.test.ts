import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "./memory-graph.js";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "eve-plus-memory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Writes a store the way an earlier version of the adapter left it on disk.
function legacyStore(sql: string, fill: (db: Database.Database) => void = () => {}) {
  const dir = tempDir();
  const db = new Database(join(dir, "graph.db"));
  db.exec(sql);
  fill(db);
  db.close();
  return dir;
}

const E = "https://eve.local/mem/e/";
const P = "https://eve.local/mem/p/";
const C = "https://eve.local/mem/c/";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const PREFIXES = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix c: <https://eve.local/mem/c/> .
@prefix p: <https://eve.local/mem/p/> .
@prefix e: <https://eve.local/mem/e/> .
`;

const counts = (g: MemoryGraph) =>
  ["triples", "lit_fts"].map(
    (table) => (g.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
  );

describe('restart survival: the SQLite file with WAL is the durable store ("container restart")', () => {
  async function restarted() {
    const dir = tempDir();
    const mg = await MemoryGraph.create({ dir });
    await mg.extendSchema({
      class: "Room",
      requires: [{ slot: "floor", datatype: "integer", minCount: 1 }],
    });
    await mg.remember({ id: "kitchen", type: "Room", label: "Kitchen", attributes: { floor: 1 } });
    mg.close();
    return MemoryGraph.create({ dir });
  }

  it("graph survives restart (data)", async () => {
    expect((await restarted()).recall("kitchen").map((f) => f.id)).toContain("kitchen");
  });

  it("ontology survives restart (still enforces lint)", async () => {
    expect((await (await restarted()).remember({ id: "x", type: "Room", label: "X" })).ok).toBe(
      false,
    );
  });
});

describe("set semantics and legacy stores", () => {
  it("re-saving an identical fact adds no triples or search rows (incl. IRI type/relation rows)", async () => {
    const g = await MemoryGraph.create({ dir: tempDir() });
    const sam = {
      id: "sam",
      label: "Sam",
      type: "ClientContact",
      attributes: { company: "Initech" },
      relations: [{ relation: "works_at", to: "initech" }],
    };
    await g.remember(sam);
    const once = counts(g);
    await g.remember(sam);
    expect(counts(g)).toEqual(once);
  });

  it("a pre-constraint store with duplicates still opens, duplicates collapsed", async () => {
    const dir = legacyStore(
      "CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT); CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o);",
      (db) => {
        for (let i = 0; i < 2; i++) {
          db.prepare("INSERT INTO triples VALUES (?,?,?,?,?)").run(
            "e:x",
            "rdf:type",
            "c:Thing",
            "iri",
            null,
          );
          db.prepare("INSERT INTO triples VALUES (?,?,?,?,?)").run(
            "e:x",
            "rdfs:label",
            "Dup",
            "lit",
            "xsd:string",
          );
          db.prepare("INSERT INTO lit_fts VALUES (?,?)").run("e:x", "Dup");
        }
      },
    );
    expect(counts(await MemoryGraph.create({ dir }))).toEqual([2, 1]);
  });

  // A v1 store holding the exact Priya end state (pending written first, confirmed after) reads "confirmed" once
  // opened, with the prior rows attributed to legacy.
  it("v1→v2 migration self-heals a stale duplicate: latest value wins, prior rows attributed to legacy", async () => {
    const dir = legacyStore(
      `CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT); CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o);
       CREATE UNIQUE INDEX u_triple ON triples(s, p, o, ot, ifnull(dt, '')); PRAGMA user_version = 1;`,
      (db) => {
        for (const [p, o, ot] of [
          [TYPE, `${C}Person`, "iri"],
          [LABEL, "Priya Nair", "lit"],
          [`${P}phone_status`, "pending", "lit"],
          [TYPE, `${C}ClientContact`, "iri"],
          [`${P}phone`, "555-0177", "lit"],
          [`${P}phone_status`, "confirmed", "lit"],
        ]) {
          db.prepare("INSERT INTO triples VALUES (?,?,?,?,?)").run(
            `${E}priya`,
            p,
            o,
            ot,
            ot === "lit" ? XSD_STRING : null,
          );
          if (ot === "lit") db.prepare("INSERT INTO lit_fts VALUES (?,?)").run(`${E}priya`, o);
        }
      },
    );
    const mv = await MemoryGraph.create({ dir });
    expect(mv.recall("Priya")[0]).toMatchObject({
      type: "ClientContact",
      attributes: { phone_status: "confirmed" },
    });
    expect(mv.history("priya").every((h) => h.origin?.source === "legacy")).toBe(true);
    expect(mv.recall("pending")).toHaveLength(0);
  });

  // A v2 store (no seq) holding text then a relation under one key: the v3 migration seeds seq from write order and
  // rebuilds the search index, so both are current and the text is findable again.
  it("v2→v3 migration: seq seeded, shadowed text visible again and searchable", async () => {
    const dir = legacyStore(
      "CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT, written_at TEXT, origin TEXT); CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o); PRAGMA user_version = 2;",
      (db) => {
        for (const [p, o, ot, dt] of [
          [TYPE, `${C}Thing`, "iri", null],
          [LABEL, "Acme Deal", "lit", XSD_STRING],
          [`${P}company`, "Globex Holdings", "lit", XSD_STRING],
          [`${P}company`, `${E}globex`, "iri", null],
        ])
          db.prepare("INSERT INTO triples VALUES (?,?,?,?,?,?,?)").run(
            `${E}deal`,
            p,
            o,
            ot,
            dt,
            null,
            JSON.stringify({ source: "legacy" }),
          );
      },
    );
    const m3 = await MemoryGraph.create({ dir });
    expect(m3.describe("deal")?.attributes.company).toBe("Globex Holdings");
    expect(m3.recall("Holdings").map((x) => x.id)).toContain("deal");
    expect(m3.db.prepare("SELECT count(*) n FROM triples WHERE seq IS NULL").get()).toEqual({
      n: 0,
    });
  });

  it("a store with appended duplicate shapes collapses to one merged definition on open", async () => {
    const shape = (slots: string[]) =>
      `\nc:ClientContactShape a sh:NodeShape ;\n  sh:targetClass c:ClientContact ;\n${slots.map((x) => `  sh:property [ sh:path p:${x} ; sh:datatype xsd:string ; sh:minCount 1 ; sh:name "${x}" ] ;`).join("\n")}\n  sh:closed false .\n`;
    const dir = legacyStore("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);", (db) =>
      db
        .prepare("INSERT INTO meta VALUES (?,?)")
        // The red-team's exact duplication.
        .run(
          "ontology",
          PREFIXES +
            shape(["phone", "company"]) +
            shape(["phone", "company", "alwaysreplyinfrench"]),
        ),
    );
    const g = await MemoryGraph.create({ dir });
    expect(
      g
        .shapeIndex()
        .filter((r) => r.class === "ClientContact")
        .map((r) => r.summary),
    ).toEqual(["ClientContact (requires phone, company, alwaysreplyinfrench)"]);
  });

  // Only a raw shape could author xsd:dateTime; deriving a definition from it rendered "sh:datatype undefined" and the
  // store could not open.
  it("a legacy shape with an inexpressible datatype opens and keeps its rule", async () => {
    const dir = legacyStore("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);", (db) =>
      db
        .prepare("INSERT INTO meta VALUES (?,?)")
        .run(
          "ontology",
          PREFIXES +
            "\nc:MeetingShape a sh:NodeShape ;\n  sh:targetClass c:Meeting ;\n  sh:property [ sh:path p:starts ; sh:datatype xsd:dateTime ; sh:minCount 1 ] ;\n  sh:closed false .\n",
        ),
    );
    const g = await MemoryGraph.create({ dir });
    const r = await g.remember({
      label: "Standup",
      type: "Meeting",
      attributes: { starts: "soon" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.message).join(" ")).toContain("starts");
  });
});

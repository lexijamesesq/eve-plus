import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "./memory-graph.js";
import {
  applyScope,
  checkRefs,
  chosen,
  type Decision,
  decisionProblems,
  dryRun,
  numbered,
  plan,
  preflight,
  type Report,
  redacted,
  type ScopeReport,
} from "./migrate.js";

const E = "https://eve.local/mem/e/";
const P = "https://eve.local/mem/p/";
const C = "https://eve.local/mem/c/";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const OWNER = JSON.stringify({ source: "direct" });

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "eve-plus-migrate-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rec {
  id: string;
  label?: string;
  type?: string;
  attributes?: Record<string, string | number>;
  edges?: [string, string][];
  forgotten?: boolean;
  at?: string;
}

// A store as 0.5.2 leaves it: schema v4, no handles table, records under minted or chosen ids.
function v4Store(dir: string, recs: Rec[]) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "graph.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE triples(s TEXT, p TEXT, o TEXT, ot TEXT, dt TEXT, written_at TEXT, origin TEXT, seq INTEGER);
           CREATE INDEX i_s ON triples(s); CREATE INDEX i_po ON triples(p,o); CREATE INDEX i_sp ON triples(s,p);
           CREATE VIRTUAL TABLE lit_fts USING fts5(s UNINDEXED, o);
           CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
           CREATE TABLE schema_log(seq INTEGER PRIMARY KEY, class TEXT, def TEXT, raw TEXT, written_at TEXT, origin TEXT);
           INSERT INTO meta VALUES ('schema_log_seeded', '1');`);
  let seq = 0;
  const put = db.prepare("INSERT INTO triples VALUES (?,?,?,?,?,?,?,?)");
  const fts = db.prepare("INSERT INTO lit_fts(s, o) VALUES (?, ?)");
  for (const r of recs) {
    const s = `${E}${r.id}`;
    const at = r.at ?? "2026-01-01T00:00:00Z";
    put.run(s, TYPE, `${C}${r.type ?? "Thing"}`, "iri", null, at, OWNER, ++seq);
    if (r.label) put.run(s, LABEL, r.label, "lit", `${XSD}string`, at, OWNER, ++seq);
    for (const [k, v] of Object.entries(r.attributes ?? {}))
      put.run(
        s,
        `${P}${k}`,
        String(v),
        "lit",
        `${XSD}${typeof v === "number" ? "integer" : "string"}`,
        at,
        OWNER,
        ++seq,
      );
    for (const [rel, to] of r.edges ?? [])
      put.run(s, `${P}${rel}`, `${E}${to}`, "iri", null, at, OWNER, ++seq);
    if (r.forgotten) {
      put.run(s, TYPE, "", "tomb", null, at, OWNER, ++seq);
      if (r.label) put.run(s, LABEL, "", "tomb", null, at, OWNER, ++seq);
      for (const k of Object.keys(r.attributes ?? {}))
        put.run(s, `${P}${k}`, "", "tomb", null, at, OWNER, ++seq);
      for (const [rel, to] of r.edges ?? [])
        put.run(s, `${P}${rel}`, `${E}${to}`, "tomb-edge", null, at, OWNER, ++seq);
    } else {
      if (r.label) fts.run(s, r.label);
      for (const v of Object.values(r.attributes ?? {})) fts.run(s, String(v));
    }
  }
  db.prepare("INSERT INTO meta VALUES ('seq_hwm', ?)").run(String(seq));
  db.pragma("user_version = 4");
  db.close();
}

const store = (recs: Rec[]) => {
  const dir = join(tempDir(), "scope");
  v4Store(dir, recs);
  return dir;
};
const clash = (r: ScopeReport, handle: string) => {
  const c = r.clashes.find((x) => x.handle === handle);
  if (!c) throw new Error(`no clash on ${handle}: ${r.clashes.map((x) => x.handle).join(", ")}`);
  return c;
};
const option = (r: ScopeReport, handle: string, match: RegExp) => {
  const o = clash(r, handle).options.find((x) => match.test(x.summary));
  if (!o) throw new Error(`no option ${match} on ${handle}`);
  return o.decision;
};
const open = (dir: string) => MemoryGraph.create({ dir });

describe("the dry run plans on a copy and never writes the store", () => {
  it("leaves a v4 store byte-identical and still at user_version 4", async () => {
    const dir = store([
      { id: "sam_ab12", label: "Sam Lee", attributes: { phone: "555" } },
      { id: "sam_cd34", label: "sam lee", attributes: { phone: "555", email: "s@x" } },
      { id: "kettle_ef56", label: "Kettle" },
    ]);
    const before = createHash("sha256")
      .update(readFileSync(join(dir, "graph.db")))
      .digest("hex");
    const r = await dryRun(dir, "scope", []);
    expect(
      createHash("sha256")
        .update(readFileSync(join(dir, "graph.db")))
        .digest("hex"),
    ).toBe(before);
    const db = new Database(join(dir, "graph.db"), { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    db.close();
    expect(r.mints).toEqual(["kettle_ef56"]);
    const c = clash(r, "sam-lee");
    expect(c.members.map((m) => m.id).sort()).toEqual(["sam_ab12", "sam_cd34"]);
    expect(c.proposal).toBe("duplicate");
    expect(c.options.every((o) => o.ok)).toBe(true);
  });
});

describe("a confirmed merge carries details over, retracts the duplicate, and the counts add up", () => {
  it("merges into the survivor, mints its handle, and records, triples and handles move exactly", async () => {
    const dir = store([
      {
        id: "sam_ab12",
        label: "Sam Lee",
        attributes: { phone: "555" },
        at: "2026-01-01T00:00:00Z",
      },
      {
        id: "sam_cd34",
        label: "Sam Lee",
        attributes: { phone: "556", email: "s@x", floor: 3 },
        edges: [
          ["works_at", "acme_zz99"],
          ["knows", "gone_0000"],
        ],
        at: "2026-02-01T00:00:00Z",
      },
      { id: "acme_zz99", label: "Acme" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const d = { ...option(dry, "sam-lee", /into sam_ab12/), keys: { phone: "sam_cd34" } };
    const r = await applyScope(dir, "scope", [d], [], "run-1");
    expect(r.applied?.applied).toEqual(["scope/sam-lee"]);
    const g = await open(dir);
    const sam = g.describe("sam-lee");
    expect(sam?.id).toBe("sam_ab12");
    expect(sam?.attributes).toMatchObject({ phone: "556", email: "s@x", floor: "3" });
    expect(sam?.relations).toEqual([{ relation: "works_at", to: "acme_zz99" }]);
    expect(g.stored("sam_ab12")?.datatypes.floor).toBe("integer");
    expect(g.stored("sam_cd34")?.exists).toBe(false);
    expect(g.resolve("sam_cd34")).toMatchObject({ status: "found", id: "sam_ab12" });
    g.close();
    const { before, after, applied } = r;
    expect(after?.records).toBe((before?.records ?? 0) - (applied?.merges ?? 0));
    expect(after?.triples).toBe((before?.triples ?? 0) + (applied?.rowsWritten ?? 0));
    expect(after?.handles).toBe((before?.handles ?? 0) + (applied?.minted ?? 0));
    expect(applied?.minted).toBe(2);
  });

  it("runs as the migration, never as the owner", async () => {
    const dir = store([
      { id: "a_1", label: "Bo", attributes: { x: "1" } },
      { id: "a_2", label: "Bo", attributes: { y: "2" } },
    ]);
    const dry = await dryRun(dir, "scope", []);
    await applyScope(dir, "scope", [option(dry, "bo", /into a_1/)], [], "run-who");
    const g = await open(dir);
    const rows = g.db
      .prepare("SELECT origin FROM triples WHERE json_extract(origin, '$.run') = 'run-who'")
      .all() as { origin: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(JSON.parse(r.origin)).toMatchObject({ source: "migration", who: "unattributed" });
    g.close();
  });
});

describe("classification proposes from evidence", () => {
  it("an untyped record and a typed one with the same name lean duplicate", async () => {
    const dir = store([
      { id: "s_1", label: "Sam" },
      { id: "s_2", label: "Sam", type: "Person" },
    ]);
    expect(clash(await dryRun(dir, "scope", []), "sam").proposal).toBe("duplicate");
  });

  it("two concrete types, or one-off connections to different places, lean namesake", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", type: "Person", edges: [["works_at", "acme_1"]] },
      { id: "s_2", label: "Sam", type: "Company", edges: [["works_at", "beta_1"]] },
      { id: "acme_1", label: "Acme" },
      { id: "beta_1", label: "Beta" },
    ]);
    expect(clash(await dryRun(dir, "scope", []), "sam").proposal).toBe("namesake");
  });

  it("a connection both make to a hub isn't evidence", async () => {
    const recs: Rec[] = [{ id: "me_1", label: "Operator" }];
    for (let i = 0; i < 6; i++)
      recs.push({ id: `p_${i}`, label: `P${i}`, edges: [["knows", "me_1"]] });
    recs.push({ id: "s_1", label: "Sam", type: "Person", edges: [["knows", "me_1"]] });
    recs.push({ id: "s_2", label: "Sam", type: "Person", edges: [["knows", "me_1"]] });
    expect(clash(await dryRun(dir(recs), "scope", []), "sam").proposal).toBe("unclear");
    function dir(r: Rec[]) {
      return store(r);
    }
  });
});

describe("a namesake qualified by the operator gets the qualified handle", () => {
  it("renames one, keeps the other on the bare name", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", type: "Person", at: "2026-01-01T00:00:00Z" },
      { id: "s_2", label: "Sam", type: "Company", at: "2026-02-01T00:00:00Z" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    await applyScope(dir, "scope", [option(dry, "sam", /keep s_1/)], [], "run-q");
    const g = await open(dir);
    expect(g.resolve("sam")).toMatchObject({ status: "found", id: "s_1" });
    expect(g.resolve("sam-company")).toMatchObject({ status: "found", id: "s_2" });
    g.close();
  });
});

describe("forgotten members", () => {
  it("forget-then-save-again: release lets the live record take the name with no reservation", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", forgotten: true, at: "2026-01-01T00:00:00Z" },
      { id: "s_2", label: "Sam", at: "2026-02-01T00:00:00Z" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const c = clash(dry, "sam");
    expect(c.members.map((m) => m.state).sort()).toEqual(["forgotten", "live"]);
    expect(c.options.filter((o) => !o.decision.skip).every((o) => o.ok)).toBe(true);
    await applyScope(dir, "scope", [option(dry, "sam", /takes the name/)], [], "run-f");
    const g = await open(dir);
    expect(g.resolve("sam")).toMatchObject({ status: "found", id: "s_2" });
    g.close();
  });

  it("a group of forgotten records only: reserve one, release the rest; reserving two is refused", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", forgotten: true, at: "2026-01-01T00:00:00Z" },
      { id: "s_2", label: "Sam", forgotten: true, at: "2026-02-01T00:00:00Z" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const c = clash(dry, "sam");
    const g = await open(dir);
    const both: Decision = {
      clash: c.key,
      digest: c.digest,
      members: { s_1: "reserve", s_2: "reserve" },
    };
    expect(decisionProblems(g, c, both).join()).toMatch(/only one can/);
    expect(
      decisionProblems(g, c, {
        ...both,
        members: { s_1: "merge" as never, s_2: "release" },
      }).join(),
    ).toMatch(/can't take/);
    g.close();
    await applyScope(dir, "scope", [option(dry, "sam", /reserve the name for s_1/)], [], "run-ff");
    const g2 = await open(dir);
    expect(g2.resolve("sam")).toMatchObject({ status: "forgotten", id: "s_1" });
    g2.close();
  });
});

describe("a handle equal to another record's id is a clash, not a failed mint", () => {
  it("offers qualify or leave-handle-less, and the id keeps resolving to its record", async () => {
    const dir = store([
      { id: "acme", label: "Acme Corp" },
      { id: "acme_q1w2", label: "Acme" },
    ]);
    const dry = await dryRun(dir, "scope", ["knowledge:acme"]);
    const c = clash(dry, "acme");
    expect(c.members.find((m) => m.id === "acme")?.state).toBe("id");
    await applyScope(dir, "scope", [option(dry, "acme", /without a handle/)], ["acme"], "run-id");
    const g = await open(dir);
    expect(g.resolve("acme")).toMatchObject({ status: "found", id: "acme" });
    expect(g.stored("acme_q1w2")?.handles).toEqual([]);
    g.close();
  });
});

describe("a merged duplicate written to again under its own id (0.5.2 after a rollback) is reported, not hidden", () => {
  it("is a revived clash; carry moves the new writes to the survivor and retracts it again", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", attributes: { a: "1" } },
      { id: "s_2", label: "Sam", attributes: { b: "2" } },
    ]);
    const dry = await dryRun(dir, "scope", []);
    await applyScope(dir, "scope", [option(dry, "sam", /into s_1/)], [], "run-m");
    // 0.5.2 writes straight to the id; it never looks at merges.
    const raw = new Database(join(dir, "graph.db"));
    const seq = (raw.prepare("SELECT max(seq) AS n FROM triples").get() as { n: number }).n;
    raw
      .prepare("INSERT INTO triples VALUES (?,?,?,?,?,?,?,?)")
      .run(`${E}s_2`, `${P}c`, "3", "lit", `${XSD}string`, "2026-03-01T00:00:00Z", OWNER, seq + 1);
    raw.close();
    const again = await dryRun(dir, "scope", []);
    const c = again.clashes.find((x) => x.kind === "revived");
    expect(c?.members.map((m) => m.id)).toEqual(["s_2", "s_1"]);
    const d = c?.options[0].decision as Decision;
    await applyScope(dir, "scope", [d], [], "run-r");
    const g = await open(dir);
    expect(g.describe("sam")?.attributes).toMatchObject({ a: "1", b: "2", c: "3" });
    expect(g.stored("s_2")?.exists).toBe(false);
    g.close();
  });
});

describe("decisions are bounded: a clash with no decision, or one that changed, is skipped", () => {
  it("skips both, mints neither, and applies the rest", async () => {
    const dir = store([
      { id: "a_1", label: "Ann" },
      { id: "a_2", label: "Ann" },
      { id: "b_1", label: "Bob" },
      { id: "b_2", label: "Bob" },
      { id: "k_1", label: "Kettle" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const stale = { ...option(dry, "bob", /into b_1/), digest: "0000000000000000" };
    const r = await applyScope(dir, "scope", [stale], [], "run-s");
    expect(r.applied?.skipped.map((s) => s.clash).sort()).toEqual(["scope/ann", "scope/bob"]);
    const g = await open(dir);
    expect(g.resolve("kettle")).toMatchObject({ status: "found", id: "k_1" });
    expect(g.stored("a_1")?.handles).toEqual([]);
    expect(g.stored("b_1")?.handles).toEqual([]);
    g.close();
  });

  it("a decision stays valid when a member's value changes, and is stale when a key is added", async () => {
    const dir = store([
      { id: "a_1", label: "Ann", attributes: { x: "1" } },
      { id: "a_2", label: "Ann", attributes: { x: "2" } },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const g = await open(dir);
    await g.remember({ id: "a_1", attributes: { x: "9" } });
    expect(plan(g, "scope").clashes[0].digest).toBe(clash(dry, "ann").digest);
    await g.remember({ id: "a_1", attributes: { y: "1" } });
    expect(plan(g, "scope").clashes[0].digest).not.toBe(clash(dry, "ann").digest);
    g.close();
  });
});

describe("one clash failing is reverted alone", () => {
  it("a carry-over the survivor's rules refuse fails that clash; the others apply", async () => {
    const dir = store([
      { id: "p_1", label: "Pat", type: "Person" },
      { id: "p_2", label: "Pat", attributes: { age: "old" } },
      { id: "q_1", label: "Quin" },
      { id: "q_2", label: "Quin", attributes: { z: "1" } },
    ]);
    const g = await open(dir);
    const ext = await g.extendSchema({
      class: "Person",
      requires: [{ slot: "age", datatype: "integer", minCount: 0 }],
    });
    expect(ext.ok).toBe(true);
    g.close();
    const dry = await dryRun(dir, "scope", []);
    expect(option(dry, "pat", /into p_1/)).toBeDefined();
    expect(clash(dry, "pat").options.find((o) => /into p_1/.test(o.summary))?.ok).toBe(false);
    const r = await applyScope(
      dir,
      "scope",
      [option(dry, "pat", /into p_1/), option(dry, "quin", /into q_1/)],
      [],
      "run-x",
    );
    expect(r.applied?.failed.map((f) => f.clash)).toEqual(["scope/pat"]);
    expect(r.applied?.applied).toEqual(["scope/quin"]);
    const g2 = await open(dir);
    expect(g2.stored("p_2")?.exists).toBe(true);
    expect(g2.stored("p_1")?.handles).toEqual([]);
    expect(g2.describe("quin")?.attributes).toMatchObject({ z: "1" });
    g2.close();
  });
});

describe("a clash that fails part-way is undone whole", () => {
  it("a second carry-over refused takes back the first one's writes", async () => {
    const dir = store([
      { id: "a_1", label: "Ann", type: "Person", at: "2026-01-01T00:00:00Z" },
      { id: "a_2", label: "Ann", attributes: { x: "1" }, at: "2026-02-01T00:00:00Z" },
      { id: "a_3", label: "Ann", attributes: { age: "old" }, at: "2026-03-01T00:00:00Z" },
    ]);
    const g = await open(dir);
    await g.extendSchema({
      class: "Person",
      requires: [{ slot: "age", datatype: "integer", minCount: 0 }],
    });
    g.close();
    const dry = await dryRun(dir, "scope", []);
    const r = await applyScope(dir, "scope", [option(dry, "ann", /into a_1/)], [], "run-p");
    expect(r.applied?.failed.map((f) => f.clash)).toEqual(["scope/ann"]);
    expect(r.applied?.rowsReverted).toBeGreaterThan(0);
    expect(r.after?.triples).toBe((r.before?.triples ?? 0) + (r.applied?.rowsWritten ?? 0));
    const g2 = await open(dir);
    expect(g2.stored("a_1")?.attributes).toEqual({});
    expect(g2.stored("a_2")?.exists).toBe(true);
    g2.close();
  });
});

describe("a record that already holds the handle keeps it", () => {
  it("only offers it as the survivor, and refuses a decision that merges it away", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", at: "2026-01-01T00:00:00Z" },
      { id: "s_2", label: "Sam", at: "2026-02-01T00:00:00Z" },
    ]);
    const g = await open(dir);
    expect(g.mintHandle("s_2").ok).toBe(true);
    g.close();
    const dry = await dryRun(dir, "scope", []);
    const c = clash(dry, "sam");
    expect(c.members.find((m) => m.id === "s_2")?.holds).toBe(true);
    expect(c.options.some((o) => /into s_1/.test(o.summary))).toBe(false);
    const g2 = await open(dir);
    const away: Decision = {
      clash: c.key,
      digest: c.digest,
      members: { s_1: "survivor", s_2: { merge: "s_1" } },
    };
    expect(decisionProblems(g2, c, away).join()).toMatch(/must be the one that keeps it/);
    g2.close();
    await applyScope(dir, "scope", [option(dry, "sam", /into s_2/)], [], "run-h");
    const g3 = await open(dir);
    expect(g3.resolve("sam")).toMatchObject({ status: "found", id: "s_2" });
    expect(g3.resolve("s_1")).toMatchObject({ status: "found", id: "s_2" });
    g3.close();
  });
});

describe("a merge the survivor's rules refuse is offered again without what they refuse", () => {
  it("adds a variant that leaves out the refused detail, and it applies", async () => {
    const dir = store([
      { id: "p_1", label: "Pat", type: "Person", at: "2026-01-01T00:00:00Z" },
      {
        id: "p_2",
        label: "Pat",
        attributes: { age: "old", city: "Oslo" },
        at: "2026-02-01T00:00:00Z",
      },
    ]);
    const g = await open(dir);
    await g.extendSchema({
      class: "Person",
      requires: [{ slot: "age", datatype: "integer", minCount: 0 }],
    });
    g.close();
    const dry = await dryRun(dir, "scope", []);
    const variant = clash(dry, "pat").options.find((o) => /leaving out age/.test(o.summary));
    expect(variant?.ok).toBe(true);
    expect(variant?.decision.drop).toEqual(["age"]);
    expect(clash(dry, "pat").options.at(-1)?.summary).toBe("skip");
    await applyScope(dir, "scope", [variant?.decision as Decision], [], "run-drop");
    const g2 = await open(dir);
    expect(g2.describe("pat")?.attributes).toEqual({ city: "Oslo" });
    g2.close();
  });

  it("notes a connection it didn't carry because its target no longer resolves", async () => {
    const dir = store([
      { id: "a_1", label: "Ann" },
      { id: "a_2", label: "Ann", edges: [["knows", "gone_0000"]] },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const r = await applyScope(dir, "scope", [option(dry, "ann", /into a_1/)], [], "run-n");
    expect(r.applied?.notes.join()).toMatch(/knows → gone_0000/);
  });
});

describe("decisions are checked on a copy before anything is written", () => {
  it("a new name whose handle is taken, or two records keeping one name, is an error; a stale one a note", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", type: "Person" },
      { id: "s_2", label: "Sam", type: "Company" },
      { id: "x_1", label: "Sam Acme" },
      { id: "f_1", label: "Bo", forgotten: true },
      { id: "f_2", label: "Bo" },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const sam = clash(dry, "sam");
    const bo = clash(dry, "bo");
    const taken: Decision = {
      clash: sam.key,
      digest: sam.digest,
      members: { s_1: "survivor", s_2: { qualify: "Sam (Acme)" } },
    };
    const two: Decision = {
      clash: bo.key,
      digest: bo.digest,
      members: { f_1: "reserve", f_2: "survivor" },
    };
    const stale: Decision = { ...taken, digest: "0000000000000000" };
    const r = await preflight(dir, "scope", [taken, two]);
    expect(r.errors.join()).toMatch(/knowledge:sam-acme, which another record's name makes/);
    expect(r.errors.join()).toMatch(/only one can/);
    expect((await preflight(dir, "scope", [stale])).notes.join()).toMatch(
      /changed since it was decided/,
    );
  });
});

describe("a reference only 0.5 resolved, which a new handle would send elsewhere, is taken back", () => {
  it("reports the capture in the dry run and reverts the handle in apply", async () => {
    const dir = store([
      { id: "sam_lee", label: "Samuel" },
      { id: "sl_9", label: "Sam Lee" },
    ]);
    const dry = await dryRun(dir, "scope", ["sam-lee"]);
    expect(dry.refs.find((x) => x.ref === "sam-lee")?.outcome).toBe("migration-break");
    const r = await applyScope(dir, "scope", [], ["sam-lee"], "run-cap");
    expect(r.applied?.failed.map((f) => f.clash)).toContain("scope/record:sl_9");
    expect(r.refs.find((x) => x.ref === "sam-lee")?.outcome).toBe("pin-break");
    const g = await open(dir);
    expect(g.stored("sl_9")?.handles).toEqual([]);
    expect(g.stored("sam_lee")?.handles).toEqual(["samuel"]);
    g.close();
  });
});

describe("a re-run after a partial apply converges", () => {
  it("a carry-over that landed without its merge still matches the decision, and finishes", async () => {
    const dir = store([
      { id: "a_1", label: "Ann" },
      { id: "a_2", label: "Ann", attributes: { x: "1" } },
    ]);
    const dry = await dryRun(dir, "scope", []);
    const g = await open(dir);
    // The carry-over landed; the process was killed before the merge.
    await g.remember(
      { id: "a_1", attributes: { x: "1" } },
      JSON.stringify({ source: "migration", run: "killed" }),
    );
    g.close();
    const r = await applyScope(dir, "scope", [option(dry, "ann", /into a_1/)], [], "run-2");
    expect(r.applied?.applied).toEqual(["scope/ann"]);
    const g2 = await open(dir);
    expect(g2.stored("a_2")?.exists).toBe(false);
    expect(g2.describe("ann")?.id).toBe("a_1");
    g2.close();
  });
});

describe("references", () => {
  it("a reference 0.5.2 resolved and 0.6.0 can't is a pin break, found in the dry run", async () => {
    const dir = store([{ id: "zo", label: "Zoe" }]);
    const r = await dryRun(dir, "scope", ["Zoë"]);
    expect(r.refs.find((x) => x.ref === "Zoë")?.outcome).toBe("pin-break");
  });

  it("references in details, and to merged duplicates, still resolve after the merge", async () => {
    const dir = store([
      { id: "s_1", label: "Sam" },
      { id: "s_2", label: "Sam" },
      { id: "n_1", label: "Note", attributes: { about: "see knowledge:s_2" } },
    ]);
    const dry = await dryRun(dir, "scope", []);
    expect(dry.refs.map((x) => x.ref)).toContain("s_2");
    const r = await applyScope(dir, "scope", [option(dry, "sam", /into s_1/)], ["S_2"], "run-ref");
    expect(r.refs.every((x) => x.outcome === "ok")).toBe(true);
    expect(r.refs.find((x) => x.ref === "S_2")?.after).toBe("s_1");
  });
});

describe("a reference that leads somewhere else afterwards is a break", () => {
  it("classifies a reference whose old target no longer gets it, and passes one that follows a merge", async () => {
    const dir = store([
      { id: "a_1", label: "Ann" },
      { id: "b_1", label: "Bea" },
    ]);
    const g = await open(dir);
    const legacy = new Map([
      ["a_1", "a_1"],
      ["moved", null],
    ]);
    // As if "moved" led to b_1 before and a_1 now: something captured it.
    const before = new Map<string, string | null>([
      ["a_1", "a_1"],
      ["moved", "b_1"],
    ]);
    const checks = checkRefs(g, ["a_1", "moved"], legacy, before);
    expect(checks.find((c) => c.ref === "a_1")?.outcome).toBe("ok");
    expect(checks.find((c) => c.ref === "moved")?.outcome).toBe("migration-break");
    expect(g.merge("b_1", "a_1").ok).toBe(true);
    expect(checkRefs(g, ["b_1"], new Map(), new Map([["b_1", "b_1"]]))[0].outcome).toBe("ok");
    g.close();
  });
});

describe("choosing by letter", () => {
  const report = async () => {
    const dir = store([
      { id: "s_1", label: "Sam", type: "Person", at: "2026-01-01T00:00:00Z" },
      { id: "s_2", label: "Sam", type: "Company", at: "2026-02-01T00:00:00Z" },
    ]);
    const r: Report = numbered({
      mode: "dry-run",
      dir,
      version: "test",
      scopes: [await dryRun(dir, "scope", [])],
    });
    return { dir, r };
  };

  it("maps letters and custom qualifiers to the report's decisions, and refuses what isn't there", async () => {
    const { dir, r } = await report();
    const ok = chosen(r, 'c1=Q:"Sam (Acme)"');
    expect(ok.problems).toEqual([]);
    expect(ok.decisions[0].members?.s_2).toEqual({ qualify: "Sam (Acme)" });
    expect(chosen(r, "c1=Z").problems.join()).toMatch(/no option Z/);
    expect(chosen(r, "c9=A").problems.join()).toMatch(/isn't in this report/);
    expect(chosen(r, "c1=A junk").problems.join()).toMatch(/couldn't read/);
    await applyScope(dir, "scope", ok.decisions, [], "run-l");
    const g = await open(dir);
    expect(g.resolve("sam-acme")).toMatchObject({ status: "found", id: "s_2" });
    g.close();
  });

  it("the redacted report carries no detail values", async () => {
    const dir = store([
      { id: "s_1", label: "Sam", attributes: { phone: "555-0101" } },
      { id: "s_2", label: "Sam", attributes: { phone: "555-0199", email: "sam@example.com" } },
    ]);
    const text = redacted(
      numbered({ mode: "dry-run", dir, version: "t", scopes: [await dryRun(dir, "scope", [])] }),
    );
    expect(text).toMatch(/phone:differs/);
    expect(text).toMatch(/email:only/);
    expect(text).not.toMatch(/555-01|sam@example/);
  });
});

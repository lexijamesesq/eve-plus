import { describe, expect, it } from "vitest";

import { HANDLE_MAX, handleOf, MemoryGraph, REFERENCE_PREFIX, slug } from "./memory-graph.js";

const E = "https://eve.local/mem/e/";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const saved = async (g: MemoryGraph, label: string, more: object = {}, origin?: string) => {
  const r = await g.remember({ label, type: "Thing", ...more }, origin);
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("; "));
  return r;
};
const handleRows = (g: MemoryGraph) =>
  (g.db.prepare("SELECT count(*) AS n FROM handles WHERE kind = 'handle'").get() as { n: number })
    .n;
// A record as a store from before handles holds it: rows in the log, no handle.
const legacy = (g: MemoryGraph, id: string, label: string) => {
  const put = g.db.prepare(
    "INSERT INTO triples(s,p,o,ot,dt,written_at,origin,seq) VALUES (?,?,?,?,?,?,?,(SELECT ifnull(max(seq),0)+1 FROM triples))",
  );
  put.run(
    `${E}${id}`,
    TYPE,
    "https://eve.local/mem/c/Thing",
    "iri",
    null,
    "2025-01-01T00:00:00Z",
    "{}",
  );
  put.run(
    `${E}${id}`,
    LABEL,
    label,
    "lit",
    "http://www.w3.org/2001/XMLSchema#string",
    "2025-01-01T00:00:00Z",
    "{}",
  );
  g.db.prepare("INSERT INTO lit_fts(s, o) VALUES (?, ?)").run(`${E}${id}`, label);
};

describe("today's slug() is untouched: attribute keys, relation names and schema slots", () => {
  it("is byte-identical to 0.5.2 on existing keys", () => {
    const fixture: [string, string][] = [
      ["phone", "phone"],
      ["Phone Number", "phone_number"],
      ["company_status", "company_status"],
      ["part_of", "part_of"],
      ["floor", "floor"],
      ["ClientContact", "clientcontact"],
      ["e-mail", "e_mail"],
      ["  padded  ", "padded"],
      ["Zoë", "zo"],
      ["李明", "x"],
      ["José García", "jos_garc_a"],
      ["a--b", "a_b"],
      ["__x__", "x"],
      ["2nd floor", "2nd_floor"],
      ["label", "label"],
      ["type", "type"],
      ["by_delegated", "by_delegated"],
      ["!!!", "x"],
      ["CamelCase Key", "camelcase_key"],
      ["rotated", "rotated"],
    ];
    for (const [key, out] of fixture) expect(slug(key)).toBe(out);
  });
});

describe("handleOf: a handle from a name", () => {
  it("keeps letters in their own script, lowercase, with one separator", () => {
    expect(handleOf("李明")).toBe("李明");
    expect(handleOf("Zoë")).toBe("zoë");
    expect(handleOf("José García")).toBe("josé-garcía");
    expect(handleOf("Sam (Acme)")).toBe("sam-acme");
    expect(handleOf("  Ship the_release -- now ")).toBe("ship-the-release-now");
    expect(handleOf("Ａｌｉｃｅ")).toBe("alice"); // NFKC folds full-width forms
    expect(new Set(["李明", "Zoë", "José García"].map(handleOf)).size).toBe(3);
  });

  it("lowercases: Alice and alice are one handle, Alicé is another", () => {
    expect(handleOf("Alice")).toBe(handleOf("alice"));
    expect(handleOf("Alicé")).toBe("alicé");
    expect(handleOf("Alicé")).not.toBe(handleOf("Alice"));
  });

  it("gives nothing for a name with no letters or digits", () => {
    expect(handleOf("!!!")).toBe("");
    expect(handleOf("🚀")).toBe("");
  });

  it("is capped so knowledge:<handle> fits a link, cut at a separator or a code point", () => {
    const words = handleOf(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "));
    expect(words.length).toBeLessThanOrEqual(HANDLE_MAX);
    expect(words.endsWith("-")).toBe(false);
    expect(words.split("-").every((w) => /^word\d+$/.test(w))).toBe(true); // no word cut in half
    const cjk = handleOf("李".repeat(200));
    expect(cjk.length).toBe(HANDLE_MAX);
    const astral = handleOf("𠀀".repeat(100)); // two UTF-16 units each
    expect(astral.length).toBeLessThanOrEqual(HANDLE_MAX);
    expect(astral).not.toMatch(/[\uD800-\uDBFF]$/);
    // What @eve-plus/working's linkRule accepts: at most 512 units, no spaces, <, > or |.
    for (const h of [words, cjk, astral, handleOf("José García")]) {
      const ref = `${REFERENCE_PREFIX}${h}`;
      expect(ref.length).toBeLessThanOrEqual(128);
      expect(ref).toMatch(/^knowledge:[^\s<>|]+$/);
    }
  });
});

describe("every record has a handle, and a create on a taken one fails", () => {
  it("names in every script keep distinct handles", async () => {
    const g = await MemoryGraph.create();
    for (const name of ["李明", "Zoë", "José García"]) {
      const r = await saved(g, name);
      expect(r.handle).toBe(handleOf(name));
      expect(g.resolve(`knowledge:${r.handle}`)).toMatchObject({
        status: "found",
        id: r.id,
        via: "handle",
      });
    }
  });

  it("Alice, then alice: the second create fails and names the holder; Alicé is its own", async () => {
    const g = await MemoryGraph.create();
    const alice = await saved(g, "Alice", { type: "Person" });
    const again = await g.remember({ label: "alice", type: "Person" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.holder).toMatchObject({
      id: alice.id,
      label: "Alice",
      type: "Person",
      handle: "alice",
      holds: "current",
    });
    expect(again.problems[0]?.message).toContain("knowledge:alice");
    expect((await saved(g, "Alicé")).handle).toBe("alicé");
  });

  it("a name with no letters or digits is refused with a reason", async () => {
    const g = await MemoryGraph.create();
    const r = await g.remember({ label: "!!!", type: "Thing" });
    expect(r.ok || r.problems[0]?.message).toMatch(/no letters or digits/);
    expect(handleRows(g)).toBe(0);
  });

  it("a new record needs a label", async () => {
    const g = await MemoryGraph.create();
    expect((await g.remember({ type: "Thing" })).ok).toBe(false);
  });

  it("a replayed identical create succeeds with the holder", async () => {
    const g = await MemoryGraph.create();
    const first = await saved(g, "Sam", { attributes: { phone: "1" } });
    const replay = await saved(g, "Sam", { attributes: { phone: "1" } });
    expect(replay).toMatchObject({ ok: true, id: first.id, handle: "sam", replayed: true });
    expect(handleRows(g)).toBe(1);
  });

  it("two same-name creates at once: different content gives one record and one failure", async () => {
    const g = await MemoryGraph.create();
    const [a, b] = await Promise.all([
      g.remember({ label: "Sam", type: "Thing", attributes: { phone: "1" } }),
      g.remember({ label: "Sam", type: "Thing", attributes: { phone: "2" } }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = a.ok ? b : a;
    expect(lost.ok || lost.stage).toBe("handle");
    expect(g.recall("Sam").filter((f) => f.label === "Sam")).toHaveLength(1);
    expect(handleRows(g)).toBe(1);
  });

  it("two identical creates at once: one record, and both succeed with it", async () => {
    const g = await MemoryGraph.create();
    const fact = { label: "Sam", type: "Thing", attributes: { phone: "1" } };
    const [a, b] = await Promise.all([g.remember(fact), g.remember(fact)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.id).toBe(b.id);
    expect(g.recall("Sam").filter((f) => f.label === "Sam")).toHaveLength(1);
  });

  it("a handle equal to another record's id is refused", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice", "Alice the first");
    const r = await g.remember({ label: "Alice", type: "Thing" });
    expect(r.ok || r.holder).toMatchObject({ id: "alice", holds: "id" });
  });

  it("handles are not details: not in the attribute view, the search index or the fact count", async () => {
    const g = await MemoryGraph.create();
    const r = await saved(g, "Kettle");
    // A detail that happens to be called `handle` stays apart from the record's handle in history.
    await g.remember({ id: "kettle", attributes: { handle: "@kettle" } });
    expect(
      g
        .history("kettle")
        .map((e) => e.key)
        .sort(),
    ).toEqual(["handle", "label", "record handle", "type"]);
    await g.forget({ id: "kettle", details: ["handle"] });
    expect(Object.keys(g.describe(r.id)?.attributes ?? {})).toEqual([]);
    expect(g.recall("kettle").map((f) => f.handle)).toEqual(["kettle"]);
    const indexed = g.db.prepare("SELECT o FROM lit_fts").all() as { o: string }[];
    expect(indexed.map((x) => x.o)).toEqual(["Kettle"]);
  });

  it("is unique per scope: each scope's graph has its own handles, resolving only there", async () => {
    const one = await MemoryGraph.create();
    const two = await MemoryGraph.create();
    await saved(one, "Alice");
    expect((await saved(two, "Alice")).handle).toBe("alice");
    await saved(one, "Acme");
    expect(two.resolve("knowledge:acme").status).toBe("missing");
  });
});

describe("the resolver: handle, then earlier handle, then id", () => {
  it("renames keep old handles working; renaming back writes no new handle", async () => {
    const g = await MemoryGraph.create();
    const a = await saved(g, "Alice");
    const renamed = await g.remember({ id: "knowledge:alice", label: "Alicia" });
    expect(renamed.ok && renamed.handle).toBe("alicia");
    expect(g.resolve("knowledge:alice")).toMatchObject({
      status: "found",
      id: a.id,
      handle: "alicia",
      via: "earlier",
    });
    expect(g.resolve("alicia")).toMatchObject({ id: a.id, via: "handle" });
    const back = await g.remember({ id: "alicia", label: "Alice" });
    expect(back.ok && back.handle).toBe("alice");
    expect(handleRows(g)).toBe(2);
    expect(
      g
        .history("alice")
        .filter((e) => e.key === "record handle")
        .map((e) => e.value),
    ).toEqual(["alice", "alicia"]);
  });

  it("a rename onto a handle another record holds fails the same way", async () => {
    const g = await MemoryGraph.create();
    const ann = await saved(g, "Ann");
    await saved(g, "Bea");
    const r = await g.remember({ id: "bea", label: "Ann" });
    expect(r.ok || r.holder).toMatchObject({ id: ann.id, holds: "current" });
    expect(g.describe("bea")?.label).toBe("Bea");
  });

  it("an earlier handle is taken: a create on it fails, naming the record it leads to", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Alice");
    await g.remember({ id: "alice", label: "Alicia" });
    const r = await g.remember({ label: "Alice", type: "Thing" });
    expect(r.ok || r.holder).toMatchObject({ handle: "alicia", holds: "earlier" });
  });

  it("the id step matches ids exactly, never through slug()", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "x", "Some legacy record");
    // slug("李明") is "x": a slugged id step would land on the record above.
    expect(g.resolve("李明").status).toBe("missing");
    expect(g.resolve("knowledge:x")).toMatchObject({ status: "found", id: "x", via: "id" });
  });

  it("a miss suggests the nearest handles", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Alice");
    await saved(g, "Alma");
    const miss = g.resolve("knowledge:alce");
    expect(miss.status).toBe("missing");
    if (miss.status === "missing") expect(miss.suggestions[0]).toBe("knowledge:alice");
  });

  it("every input that names a record resolves: relations, forget and remember's id", async () => {
    const g = await MemoryGraph.create();
    const acme = await saved(g, "Acme Corp");
    const sam = await saved(g, "Sam", {
      relations: [{ relation: "works_at", to: "knowledge:acme-corp" }],
    });
    expect(g.describe(sam.id)?.relations).toEqual([{ relation: "works_at", to: acme.id }]);
    const dangling = await g.remember({
      label: "Bo",
      type: "Thing",
      relations: [{ relation: "works_at", to: "acme-crop" }],
    });
    expect(dangling.ok || dangling.problems[0]?.message).toMatch(
      /nothing is remembered.*knowledge:acme-corp/,
    );
    const update = await g.remember({ id: "knowledge:sma", attributes: { phone: "1" } });
    expect(update.ok || update.problems[0]?.message).toMatch(
      /Did you mean knowledge:sam\b.*leave id out/,
    );
    expect((await g.forget({ id: "knowledge:sam", details: ["works_at"] })).ok).toBe(true);
    expect(await g.forget({ id: "nobody" })).toMatchObject({ ok: false });
  });
});

describe("forgetting reserves the handle", () => {
  it("a forgotten handle never resolves to a newer record", async () => {
    const g = await MemoryGraph.create();
    const first = await saved(g, "Alice");
    await g.forget({ id: "knowledge:alice" });
    expect(g.resolve("knowledge:alice")).toMatchObject({
      status: "forgotten",
      id: first.id,
      handle: "alice",
    });
    const r = await g.remember({ label: "Alice", type: "Thing" });
    expect(r.ok || r.holder).toMatchObject({ id: first.id, holds: "forgotten" });
    expect(r.ok || r.problems[0]?.message).toMatch(/reclaim/);
    expect(g.resolve("knowledge:alice")).toMatchObject({ status: "forgotten", id: first.id });
    const link = await g.remember({
      label: "Ada",
      type: "Thing",
      relations: [{ relation: "knows", to: "alice" }],
    });
    expect(link.ok || link.problems[0]?.message).toMatch(/was forgotten/);
  });

  it("saving a forgotten record by its handle brings it back under its own handle", async () => {
    const g = await MemoryGraph.create();
    const first = await saved(g, "Ann", { attributes: { phone: "1" } });
    await g.forget({ id: "ann" });
    const back = await g.remember({ id: "knowledge:ann", label: "Ann", type: "Thing" });
    expect(back).toMatchObject({ ok: true, id: first.id, handle: "ann" });
    expect(g.describe("ann")?.attributes).toEqual({});
    expect(handleRows(g)).toBe(1);
  });

  it("only an explicit reclaim frees it, and never a live record's current handle", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Alice");
    expect(g.reclaimHandle("alice").ok).toBe(false);
    await g.forget({ id: "alice" });
    expect(g.reclaimHandle("knowledge:alice")).toEqual({ ok: true, handle: "alice" });
    const fresh = await saved(g, "Alice");
    expect(g.resolve("alice")).toMatchObject({ status: "found", id: fresh.id });
  });
});

describe("merges are followed, not rewritten", () => {
  it("a merged record's handles, id and connections lead to the record it was merged into", async () => {
    const g = await MemoryGraph.create();
    const dup = await saved(g, "Alice Bot");
    const real = await saved(g, "Alice");
    const ada = await saved(g, "Ada", { relations: [{ relation: "knows", to: "alice-bot" }] });
    expect(g.merge("alice-bot", "alice")).toEqual({ ok: true });
    expect(g.resolve("knowledge:alice-bot")).toMatchObject({
      status: "found",
      id: real.id,
      mergedFrom: [dup.id],
    });
    expect(g.resolve(dup.id)).toMatchObject({ id: real.id });
    expect(g.relate("knowledge:ada").connections).toEqual([
      { relation: "knows", target: "Alice", id: real.id, handle: "alice" },
    ]);
    // The stored edge is untouched.
    expect(g.describe(ada.id)?.relations).toEqual([{ relation: "knows", to: dup.id }]);
    // The duplicate is no longer a record of its own: not recalled, and a forget through its handle means the one thing.
    expect(g.recall("Alice Bot").map((f) => f.id)).not.toContain(dup.id);
    expect(g.describe(dup.id)?.id).toBe(real.id);
    expect(g.history(dup.id).some((e) => e.key === "merged into" && e.value === real.id)).toBe(
      true,
    );
    expect(g.merge("alice", "alice-bot").ok).toBe(false); // a cycle
    expect(g.merge("alice", "alice").ok).toBe(false);
  });
});

describe("a merge can be undone, and long names get advice that works", () => {
  it("reverting a merge brings the duplicate back as its own record", async () => {
    const g = await MemoryGraph.create();
    const dup = await saved(g, "Alice Bot", { attributes: { note: "x" } });
    await saved(g, "Alice");
    expect(g.merge("alice-bot", "alice", JSON.stringify({ callId: "m" })).ok).toBe(true);
    expect((await g.revertBatch({ callId: "m" })).conflicts).toEqual([]);
    expect(g.resolve("alice-bot")).toMatchObject({ status: "found", id: dup.id, via: "handle" });
    expect(g.describe("alice-bot")?.attributes.note).toBe("x");
  });

  it("past the cap, a qualifier at the end can't tell two names apart, so the advice says put it first", async () => {
    const g = await MemoryGraph.create();
    const long = `Planning notes ${"word ".repeat(30)}`.trim();
    await saved(g, long);
    const r = await g.remember({ label: long, type: "Thing", attributes: { other: "1" } });
    expect(r.ok || r.problems[0]?.message).toMatch(/put what tells them apart first/);
    expect(handleOf(`${long} (Acme)`)).toBe(handleOf(long));
    expect(handleOf(`Acme: ${long}`)).not.toBe(handleOf(long));
  });

  it("two renames onto one name at once: one lands, the other fails naming it", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Ann");
    await saved(g, "Bea");
    const [a, b] = await Promise.all([
      g.remember({ id: "ann", label: "Cleo" }),
      g.remember({ id: "bea", label: "Cleo" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = a.ok ? b : a;
    expect(lost.ok || lost.holder?.holds).toBe("current");
    expect(g.resolve("cleo").status).toBe("found");
  });
});

describe("records saved before handles: shown by id, given a handle only by mintHandle", () => {
  it("resolve by id, and a rename assigns nothing", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice_ab12", "Alice");
    expect(g.resolve("knowledge:alice_ab12")).toMatchObject({ status: "found", via: "id" });
    expect(g.recall("Alice")[0]).toMatchObject({ id: "alice_ab12", handle: undefined });
    expect((await g.remember({ id: "alice_ab12", label: "Alicia" })).ok).toBe(true);
    expect(handleRows(g)).toBe(0);
  });

  it("a create on the name an unmigrated record would get fails, naming it by id", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice_ab12", "Alice");
    const r = await g.remember({ label: "Alice", type: "Person" });
    expect(r.ok || r.holder).toMatchObject({ id: "alice_ab12", holds: "unmigrated" });
    expect(r.ok || r.problems[0]?.message).toContain("knowledge:alice_ab12");
    expect(handleRows(g)).toBe(0);
  });

  it("mintHandle gives the handle its current name makes, or names the holder", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice_ab12", "Alice");
    legacy(g, "alice_cd34", "Alice");
    expect(g.mintHandle("alice_ab12")).toEqual({ ok: true, handle: "alice" });
    expect(g.mintHandle("alice_ab12")).toEqual({ ok: true, handle: "alice" });
    const clash = g.mintHandle("alice_cd34");
    expect(clash.ok || clash.holder).toMatchObject({ id: "alice_ab12", holds: "current" });
    expect(g.resolve("knowledge:alice")).toMatchObject({ id: "alice_ab12", via: "handle" });
  });
});

describe("ids as 0.5 resolved them, and a migration's own verbs", () => {
  it("an id written in another case still resolves; other scripts never reach slug()", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice_x7k2", "Alice");
    expect(g.resolve("knowledge:Alice_X7K2")).toMatchObject({
      status: "found",
      id: "alice_x7k2",
      via: "id",
    });
    expect(g.describe("Alice_X7K2")?.label).toBe("Alice");
  });

  it("a record forgotten before handles is reserved under its last name", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "ghost_ab12", "Ghost");
    await g.forget({ id: "ghost_ab12" });
    expect(g.mintHandle("ghost_ab12")).toEqual({ ok: true, handle: "ghost" });
    expect(g.resolve("knowledge:ghost")).toMatchObject({ status: "forgotten", id: "ghost_ab12" });
    const r = await g.remember({ label: "Ghost", type: "Thing" });
    expect(r.ok || r.holder?.holds).toBe("forgotten");
  });

  it("reverting a run that minted handles leaves its records as they were, with no conflict", async () => {
    const g = await MemoryGraph.create();
    legacy(g, "alice_ab12", "Alice");
    legacy(g, "acme_cd34", "Acme");
    const run = JSON.stringify({ run: "m1" });
    expect(g.mintHandle("alice_ab12", run).ok && g.mintHandle("acme_cd34", run).ok).toBe(true);
    expect(g.merge("acme_cd34", "alice_ab12", run).ok).toBe(true);
    const r = await g.revertBatch({ run: "m1" });
    // Two handles, the merge, and the duplicate's two tombstones.
    expect(r).toMatchObject({ removed: 5, conflicts: [] });
    expect(handleRows(g)).toBe(0);
    expect(g.resolve("acme_cd34")).toMatchObject({ status: "found", id: "acme_cd34" });
    expect(g.describe("acme_cd34")?.label).toBe("Acme");
  });
});

describe("history and revert cover handles", () => {
  it("reverting a create removes its handle", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Alice", {}, JSON.stringify({ callId: "c1" }));
    expect((await g.revertBatch({ callId: "c1" })).removed).toBe(3);
    expect(g.resolve("alice").status).toBe("missing");
    expect((await saved(g, "Alice")).handle).toBe("alice");
  });

  it("a revert that would restore a handle another record holds now reports it, and applies nothing", async () => {
    const g = await MemoryGraph.create();
    const first = await saved(g, "Alice");
    await g.forget({ id: "alice" });
    g.reclaimHandle("alice", JSON.stringify({ callId: "reclaim" }));
    const second = await saved(g, "Alice");
    const r = await g.revertBatch({ callId: "reclaim" });
    expect(r).toMatchObject({
      removed: 0,
      conflicts: [{ id: first.id, handle: "alice", heldBy: second.id }],
    });
    expect(g.resolve("alice")).toMatchObject({ status: "found", id: second.id });
  });

  it("undoing a rename onto a name that has moved on is reported the same way", async () => {
    const g = await MemoryGraph.create();
    const a = await saved(g, "Alice");
    await g.remember({ id: "alice", label: "Alicia" }, JSON.stringify({ callId: "rename" }));
    g.reclaimHandle("alice");
    const b = await saved(g, "Alice");
    const r = await g.revertBatch({ callId: "rename" });
    expect(r.conflicts).toEqual([{ id: a.id, handle: "alice", heldBy: b.id }]);
    expect(g.describe(a.id)?.label).toBe("Alicia");
  });

  it("a revert with no conflict reports none", async () => {
    const g = await MemoryGraph.create();
    await saved(g, "Alice");
    await g.remember({ id: "alice", label: "Alicia" }, JSON.stringify({ callId: "rename" }));
    expect((await g.revertBatch({ callId: "rename" })).conflicts).toEqual([]);
    expect(g.resolve("alice")).toMatchObject({ via: "handle" });
  });
});

describe("recall finds a record by its name in any script", () => {
  const people = async () => {
    const g = await MemoryGraph.create();
    for (const name of ["Zoë Park", "José García", "李明", "Kitchen floor"]) await saved(g, name);
    return g;
  };
  const found = (g: MemoryGraph, query: string) => g.recall(query).map((f) => f.label);

  it("by the name as written", async () => {
    const g = await people();
    expect(found(g, "Zoë")).toEqual(["Zoë Park"]);
    expect(found(g, "José García")).toEqual(["José García"]);
    expect(found(g, "李明")).toEqual(["李明"]);
    // A two-character name isn't noise beside longer words.
    expect(found(g, "where does 李明 sit")).toEqual(["李明"]);
    expect(g.relate("José").label).toBe("José García");
  });

  it("without the accents, and from compatibility forms", async () => {
    const g = await people();
    expect(found(g, "zoe")).toEqual(["Zoë Park"]);
    expect(found(g, "garcia")).toEqual(["José García"]);
    expect(found(g, "Ｚｏë")).toEqual(["Zoë Park"]); // full-width, folded by NFKC
  });

  it("ASCII search is unchanged", async () => {
    const g = await people();
    expect(found(g, "kitchen")).toEqual(["Kitchen floor"]);
    expect(found(g, "the kitchen is on the floor")).toEqual(["Kitchen floor"]);
    // A short word beside longer ones is noise: a record that shares only "is" isn't recalled.
    await saved(g, "Life is good");
    expect(found(g, "where is the attic")).toEqual([]);
  });

  it("short words in other alphabetic scripts are noise too; a one-character Han word isn't", async () => {
    const g = await people();
    await saved(g, "Plan a trip to Lisbon");
    await saved(g, "Ou bien");
    // "à" and "où" fold to "a" and "ou" in the index: kept, they would recall both records above.
    expect(found(g, "voilà à Lisbon")).toEqual(["Plan a trip to Lisbon"]);
    expect(found(g, "où est 李明")).toEqual(["李明"]);
    await saved(g, "李");
    expect(found(g, "who is 李 today")).toEqual(["李"]);
  });
});

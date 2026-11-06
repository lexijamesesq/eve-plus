import { describe, expect, it } from "vitest";

import { handleOf, slug } from "./memory-graph.js";

// Frozen from memory--v0.5.2's slug() (commit a75802286a2985bdc7507f876e71994e5fe591cb), run over invented names
// shaped like real stores' attribute keys, relation names and schema slots as an agent authors them. Regenerate with:
//   git show memory--v0.5.2:packages/memory/src/memory-graph.ts | sed -n '/^export const slug = /,/|| "x";/p'
// saved as a module, then printing [input, slug(input)] for each input below. Ids, keys and relation names on disk
// were all made by that function, so any change to its output would orphan them.
const V052: [string, string][] = [
  ["phone", "phone"],
  ["Phone", "phone"],
  ["PHONE", "phone"],
  ["phone number", "phone_number"],
  ["Phone Number", "phone_number"],
  ["phone_number", "phone_number"],
  ["phoneNumber", "phonenumber"],
  ["phone-number", "phone_number"],
  ["  phone  ", "phone"],
  ["phone\tnumber", "phone_number"],
  ["phone\nnumber", "phone_number"],
  ["e-mail", "e_mail"],
  ["E-Mail Address", "e_mail_address"],
  ["email_address", "email_address"],
  ["emailAddress", "emailaddress"],
  ["works_at", "works_at"],
  ["worksAt", "worksat"],
  ["Works At", "works_at"],
  ["works-at", "works_at"],
  ["part of", "part_of"],
  ["part_of", "part_of"],
  ["reports to", "reports_to"],
  ["reportsTo", "reportsto"],
  ["member_of", "member_of"],
  ["lives_in", "lives_in"],
  ["born_on", "born_on"],
  ["birthday", "birthday"],
  ["start date", "start_date"],
  ["start_date", "start_date"],
  ["2nd floor", "2nd_floor"],
  ["floor 2", "floor_2"],
  ["company_status", "company_status"],
  ["Company Status", "company_status"],
  ["status", "status"],
  ["notes", "notes"],
  ["Notes!", "notes"],
  ["notes?", "notes"],
  ["notes...", "notes"],
  ["(notes)", "notes"],
  ["last_contacted", "last_contacted"],
  ["last contacted", "last_contacted"],
  ["lastContacted", "lastcontacted"],
  ["handle", "handle"],
  ["record handle", "record_handle"],
  ["label", "label"],
  ["type", "type"],
  ["id", "id"],
  ["url", "url"],
  ["URL", "url"],
  ["github_url", "github_url"],
  ["GitHub URL", "github_url"],
  ["x", "x"],
  ["_x_", "x"],
  ["__x__", "x"],
  ["a--b", "a_b"],
  ["a__b", "a_b"],
  ["a  b", "a_b"],
  ["a_-_b", "a_b"],
  ["Zoë", "zo"],
  ["José García", "jos_garc_a"],
  ["naïve", "na_ve"],
  ["café", "caf"],
  ["Müller", "m_ller"],
  ["Øster", "ster"],
  ["straße", "stra_e"],
  ["ﬁle", "le"],
  ["Ångström", "ngstr_m"],
  ["李明", "x"],
  ["日本語", "x"],
  ["Ελληνικά", "x"],
  ["Москва", "x"],
  ["مرحبا", "x"],
  ["😀", "x"],
  ["emoji 😀 key", "emoji_key"],
  ["", "x"],
  ["   ", "x"],
  ["!!!", "x"],
  ["123", "123"],
  ["0", "0"],
  ["v2.1", "v2_1"],
  ["C++", "c"],
  ["C#", "c"],
  ["node.js", "node_js"],
  ["k8s", "k8s"],
  ["ID", "id"],
  ["ClientContact", "clientcontact"],
  ["client contact", "client_contact"],
  ["Client_Contact", "client_contact"],
];

describe("slug() is byte-identical to 0.5.2's", () => {
  it.each(V052)("slug(%j) is %j", (input, out) => {
    expect(slug(input)).toBe(out);
  });

  it("is idempotent on everything it produced, as every stored key is", () => {
    for (const [, out] of V052) expect(slug(out)).toBe(out);
  });

  it("is never what makes a handle", () => {
    expect(handleOf.toString()).not.toContain("slug(");
    expect(handleOf("Zoë")).not.toBe(slug("Zoë"));
  });
});

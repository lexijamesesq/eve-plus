import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CommissionStore } from "@eve-plus/commissioning/store";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requiredEnv } from "../lib/env.js";
export default defineTool({
  description: "Fixture-only independent inspection of the committed acceptance marker.",
  inputSchema: z.object({ commissionId: z.string() }).strict(),
  execute({ commissionId }, ctx) {
    if (
      ctx.session.auth.current?.authenticator !== "fixture-owner" ||
      ctx.session.auth.current.principalId !== "fixture:owner"
    )
      throw new Error("Fixture owner required");
    const store = new CommissionStore(
      join(requiredEnv("FIXTURE_DATA_DIR"), "native-proof", "commissions.sqlite"),
    );
    try {
      const proposal = store.read(
        { verified: true, principalId: "fixture:owner" },
        commissionId,
      ).currentProposal;
      if (proposal?.artifact.repository !== "https://example.test/repo")
        throw new Error("Expected allowlisted fixture artifact");
      let pass = false;
      try {
        pass =
          execFileSync(
            "git",
            [
              "-C",
              requiredEnv("FIXTURE_GIT_DIR"),
              "show",
              `${proposal.artifact.commit}:acceptance.txt`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim() === "ready";
      } catch {
        /* Missing objects fail inspection. */
      }
      appendFileSync(
        requiredEnv("FIXTURE_AUDIT"),
        `${JSON.stringify({ stage: "independent-inspection", sessionId: ctx.session.id, proposalId: proposal.proposalId, commit: proposal.artifact.commit, pass })}\n`,
      );
      return { proposalId: proposal.proposalId, commit: proposal.artifact.commit, pass };
    } finally {
      store.close();
    }
  },
});

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CommissionStore } from "@eve-plus/commissioning/store";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requiredEnv } from "../lib/env.js";
import { identity, ownerId } from "../lib/identity.js";

// Deliberately narrow demonstration policy: inspect one marker in an allowlisted local repository.
export default defineTool({
  description: "Independently inspect acceptance.txt in the current immutable proposal commit.",
  inputSchema: z.object({ commissionId: z.string() }).strict(),
  execute({ commissionId }, ctx) {
    if (identity.resolveSessionPrincipal(ctx.session.auth.current)?.principalId !== ownerId)
      throw new Error("Example commissioner required");
    const store = new CommissionStore(
      join(requiredEnv("EXAMPLE_DATA_DIR"), "example-commissions", "commissions.sqlite"),
    );
    try {
      const proposal = store.read(
        { verified: true, principalId: ownerId },
        commissionId,
      ).currentProposal;
      if (!proposal || proposal.artifact.repository !== requiredEnv("EXAMPLE_ARTIFACT_REPOSITORY"))
        throw new Error("Expected the configured example artifact repository");
      let pass = false;
      try {
        pass =
          execFileSync(
            "git",
            [
              "-C",
              requiredEnv("EXAMPLE_GIT_DIR"),
              "show",
              `${proposal.artifact.commit}:acceptance.txt`,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim() === "ready";
      } catch {
        /* Missing objects fail inspection. */
      }
      return { proposalId: proposal.proposalId, commit: proposal.artifact.commit, pass };
    } finally {
      store.close();
    }
  },
});

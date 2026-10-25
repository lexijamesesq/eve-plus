// resolve-exports.mjs <package_name>
//
// Copied into a consumer project's root and run there: an import resolves from the importing file, so the package
// resolves by name exactly as a consumer's own import would. Every target in the installed package's exports must
// exist, and every import entry must load. Exits non-zero, listing each problem, otherwise.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
const root = join("node_modules", name);
const { exports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];

for (const [subpath, conditions] of Object.entries(exports)) {
  for (const target of Object.values(conditions)) {
    if (!existsSync(join(root, target))) problems.push(`${subpath}: ${target} is missing`);
  }
  if (conditions.import !== undefined) {
    const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
    try {
      await import(specifier);
    } catch (error) {
      problems.push(`${subpath}: import failed: ${error.message}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

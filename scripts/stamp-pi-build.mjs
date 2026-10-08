import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The Pi package ships TS source, not the root dist tree. Stamp the packaged
// source alongside it during the dist build; null is the only honest identity
// for a dirty source tree (HEAD is not the code that was built).
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  encoding: "utf8",
}).trim();
let gitSha = null;
if (!dirty) {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error("Invalid build git SHA");
}
writeFileSync(
  resolve("packages/shepy-pi/src/build-info.generated.json"),
  `${JSON.stringify({ gitSha })}\n`,
);
console.log(gitSha ? `Shepy Pi build: ${gitSha}` : "Shepy Pi build: gitSha unknown (dirty tree)");

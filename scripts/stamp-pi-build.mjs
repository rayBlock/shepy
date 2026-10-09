import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const target = resolve("packages/shepy-pi/src/build-info.generated.json");
const temp = resolve(dirname(target), `.build-info.generated.${process.pid}.${randomUUID()}.tmp`);
try {
  // Exclusive same-directory temp: readers see either complete old or complete new data.
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ gitSha })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
} finally {
  rmSync(temp, { force: true });
}
console.log(gitSha ? `Shepy Pi build: ${gitSha}` : "Shepy Pi build: gitSha unknown (dirty tree)");

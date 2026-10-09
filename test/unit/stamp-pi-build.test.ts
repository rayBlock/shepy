import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const script = resolve("scripts/stamp-pi-build.mjs");

describe("Pi build stamp replacement", () => {
  test("atomically replaces an old stamp rather than truncating its inode", () => {
    const root = mkdtempSync(join(tmpdir(), "shepy-stamp-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      // Keep the fixture dirty: no HEAD required and a null identity is honest.
      writeFileSync(join(root, "untracked"), "dirty\n");
      const directory = join(root, "packages", "shepy-pi", "src");
      mkdirSync(directory, { recursive: true });
      const target = join(directory, "build-info.generated.json");
      writeFileSync(target, '{"gitSha":"old"}\n');
      const old = statSync(target);

      execFileSync(process.execPath, [script], { cwd: root });

      expect(readFileSync(target, "utf8")).toBe('{"gitSha":null}\n');
      expect(statSync(target).ino).not.toBe(old.ino);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, "untracked"), "utf8")).toBe("dirty\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type PackageManifest = {
  bin?: Record<string, string>;
  files?: string[];
  name: string;
  private?: boolean;
  publishConfig?: { access?: string };
  repository?: { directory?: string; type?: string; url?: string };
  scripts?: Record<string, string>;
  version: string;
};

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as PackageManifest;
}

describe("npm publication metadata", () => {
  test("keeps public packages scoped and the Herdr integration private", async () => {
    const root = await readManifest("../../package.json");
    const pi = await readManifest("../../packages/shepy-pi/package.json");
    const herdr = await readManifest("../../packages/shepy-herdr-plugin/package.json");
    const pluginToml = await readFile(
      new URL("../../packages/shepy-herdr-plugin/herdr-plugin.toml", import.meta.url),
      "utf8",
    );
    const pluginVersion = /^version = "([^"]+)"$/m.exec(pluginToml)?.[1];

    expect(root.name).toBe("shepy");
    expect(root.bin).toEqual({ shepy: "dist/src/cli/shepy.js" });
    expect(root.files).toEqual(["dist", "drizzle"]);
    expect(root.publishConfig?.access).toBe("public");
    expect(root.scripts).toMatchObject({
      "clean:dist": "node scripts/clean-dist.mjs",
      "package:check": "node scripts/check-root-package.mjs",
      "hooks:install": "husky",
      prepack: "pnpm build",
    });
    // No install lifecycle runs Husky for npm or git-URL consumers; hooks are an
    // explicit developer step after dependencies exist (`pnpm hooks:install`).
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "preprepare",
      "prepare",
      "postprepare",
      "pnpm:devPreinstall",
    ]) {
      expect(root.scripts).not.toHaveProperty(lifecycle);
    }
    expect(
      Object.entries(root.scripts ?? {})
        .filter(([, command]) => /\bhusky\b/.test(command))
        .map(([name]) => name),
    ).toEqual(["hooks:install"]);
    expect(root.scripts?.build).toContain("pnpm clean:dist");
    expect(root.scripts?.check).toContain("pnpm package:check");

    expect(pi.name).toBe("shepy-pi");
    expect(pi.files).toEqual(["src"]);
    expect(pi.publishConfig?.access).toBe("public");
    expect(pi.repository).toEqual({
      type: "git",
      url: "git+https://github.com/rayBlock/shepy.git",
      directory: "packages/shepy-pi",
    });

    expect(herdr.private).toBe(true);
    expect(pluginVersion).toBeDefined();
    expect(new Set([root.version, pi.version, herdr.version, pluginVersion])).toEqual(
      new Set([root.version]),
    );
  });
});

describe("developer hook setup", () => {
  test("hooks:install runs the real Husky and configures the tracked hooks", async () => {
    const husky = fileURLToPath(new URL("../../node_modules/husky/bin.js", import.meta.url));
    await access(husky, constants.R_OK);
    const preCommit = await readFile(new URL("../../.husky/pre-commit", import.meta.url), "utf8");
    const repo = await mkdtemp(join(tmpdir(), "shepy-hooks-install-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("GIT_") && key !== "HUSKY",
      ),
    );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repo, env });
      await mkdir(join(repo, ".husky"));
      await writeFile(join(repo, ".husky", "pre-commit"), preCommit);
      execFileSync(process.execPath, [husky], { cwd: repo, env, stdio: "pipe" });
      expect(
        execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
          cwd: repo,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe(".husky/_");
      await access(join(repo, ".husky", "_", "pre-commit"), constants.X_OK);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

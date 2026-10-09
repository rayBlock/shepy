import { vi } from "vitest";

/**
 * Sandbox for the ambient build stamp
 * (packages/shepy-pi/src/build-info.generated.json).
 *
 * The stamp is gitignored, machine-local state produced by `pnpm build`: a
 * built checkout carries a real commit SHA, an unbuilt one carries none. The
 * production extension forwards whatever identity the stamp carries, which is
 * correct — so the suite must never let ambient checkout state decide test
 * outcomes. This is the same leak class as SHEPY_PROFILE: sandbox it in the
 * test environment, never in production.
 *
 * The sandbox shadows exactly one node:fs read (paths ending in
 * build-info.generated.json) for modules imported after installation; every
 * other read is delegated to the original node:fs untouched.
 */
export type BuildStampFixture =
  | { kind: "corrupted"; raw: string }
  | { kind: "stamped"; gitSha: string }
  | { kind: "unreadable"; message: string }
  | { kind: "unstamped" };

const stampSuffix = "build-info.generated.json";

let currentFixture: BuildStampFixture = { kind: "unstamped" };
let installed = false;

function stampResponse(): string {
  const fixture = currentFixture;
  switch (fixture.kind) {
    case "stamped":
      return JSON.stringify({ gitSha: fixture.gitSha });
    case "corrupted":
      return fixture.raw;
    case "unreadable":
      throw new Error(fixture.message);
    case "unstamped":
      throw new Error(`ENOENT: ambient build stamp sandboxed away (${stampSuffix})`);
  }
}

/**
 * Install the node:fs interception (once per test file) and select the
 * fixture that subsequent module imports will observe. Defaults to the
 * unstamped identity so the suite is independent of how the checkout was
 * last built. Re-calling it with a new fixture (plus vi.resetModules())
 * re-points the sandbox — used by the deliberate-injection controls.
 */
export function installAmbientBuildStampSandbox(
  fixture: BuildStampFixture = { kind: "unstamped" },
): void {
  currentFixture = fixture;
  if (installed) return;
  installed = true;
  vi.doMock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    return {
      ...original,
      readFileSync: (path: Parameters<typeof original.readFileSync>[0], ...args: unknown[]) => {
        if (String(path).endsWith(stampSuffix)) {
          return stampResponse();
        }
        return original.readFileSync(path, ...(args as ["utf8"]));
      },
    };
  });
}

/**
 * Re-point the sandbox at a new fixture for subsequent module re-imports.
 * Pair with vi.resetModules() so the extension graph re-reads the stamp.
 */
export function selectBuildStampFixture(fixture: BuildStampFixture): void {
  currentFixture = fixture;
}

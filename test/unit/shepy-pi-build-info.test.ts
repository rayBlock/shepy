import { afterEach, describe, expect, test, vi } from "vitest";

const modulePath = "../../packages/shepy-pi/src/build-info.js";

async function importWithStamp(stamp: string | Error): Promise<{ gitSha: string | null; pkgVersion: string }> {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    return {
      ...original,
      readFileSync: (path: Parameters<typeof original.readFileSync>[0], ...args: unknown[]) => {
        if (String(path).endsWith("/build-info.generated.json")) {
          if (stamp instanceof Error) throw stamp;
          return stamp;
        }
        return original.readFileSync(path, ...args as ["utf8"]);
      },
    };
  });
  const { extensionBuild } = await import(modulePath);
  return extensionBuild;
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("Shepy Pi lazy build identity", () => {
  test("malformed, partial and unreadable stamps skip the SHA as UNKNOWN without throwing at import", async () => {
    for (const stamp of ["{", "null", "[]", "{}", '{"gitSha":42}', '{"gitSha":"bad"}', new Error("EACCES")]) {
      expect(await importWithStamp(stamp)).toEqual({ pkgVersion: "0.5.0", gitSha: null });
    }
  });

  test("accepts only a valid full commit stamp", async () => {
    const gitSha = "a".repeat(40);
    expect(await importWithStamp(JSON.stringify({ gitSha }))).toEqual({ pkgVersion: "0.5.0", gitSha });
  });
});

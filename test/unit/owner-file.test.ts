import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  casOwnerRecord,
  type HandledRecord,
  OwnerFileStorageError,
  type OwnerRecord,
  ownerLockPath,
  ownerRecordPath,
  readOwnerRecord,
} from "@/cli/owner-file.js";

/**
 * Unit gates for the owner-record store: collision-free filename derivation,
 * the profileId-misread defense, atomic replacement semantics (mode 0600,
 * inode replacement, symlink refusal), and the bounded cross-process lock —
 * contention gives up within the budget, a crashed holder's lock is stolen,
 * and unusable storage is a classified failure. The cross-process behaviors
 * themselves (real races, SIGKILL windows) are gated in
 * test/integration/claude-hook.test.ts with real hook processes.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function openHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepy-owner-file-"));
  tempDirs.push(dir);
  return dir;
}

function record(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    delivered: null,
    leaseToken: "lease-token",
    ownerSessionRefJson: "{}",
    profileId: "driffs",
    ...overrides,
  };
}

function writeRecordDirectly(
  home: string,
  sessionId: string,
  profileId: string,
  next: OwnerRecord,
): void {
  const path = ownerRecordPath(home, sessionId, profileId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

describe("owner-record filename derivation", () => {
  test("distinct profile ids that the old sanitizer collapsed get distinct files", () => {
    // The schema allows any non-empty string; the OLD derivation sanitized
    // both of these onto `claude-<session>-a_b.json` — two profiles sharing
    // one owner record, each acking through the other's identity.
    expect(ownerRecordPath("/home", "s1", "a:b")).not.toBe(ownerRecordPath("/home", "s1", "a_b"));
    expect(ownerRecordPath("/home", "s1", "a/b")).not.toBe(ownerRecordPath("/home", "s1", "a_b"));
    // Distinct sessions cannot collide either.
    expect(ownerRecordPath("/home", "s:1", "p")).not.toBe(ownerRecordPath("/home", "s_1", "p"));
  });

  test("the encoded pairing is injective: no two (session, profile) pairs share a path", () => {
    // Adversarial alphabet: the pair separator ".", base64url letters, the
    // fallback trigger, characters the old scheme mangled, unicode, padding.
    const tokens = ["a", "a.", ".a", "a.a", "a_", "_a", "a:", ":a", "a~", "~a", "ä", "a "];
    const paths = new Set<string>();
    let pairs = 0;
    for (const session of tokens) {
      for (const profile of tokens) {
        const path = ownerRecordPath("/home", session, profile);
        expect(paths.has(path), `${JSON.stringify(session)} / ${JSON.stringify(profile)}`).toBe(
          false,
        );
        paths.add(path);
        pairs += 1;
      }
    }
    expect(pairs).toBe(tokens.length ** 2);
    expect(paths.size).toBe(pairs);
  });

  test("absurdly long ids stay under the filesystem name limit via the hash fallback", () => {
    const longProfile = `long-${"x".repeat(400)}-end`;
    const path = ownerRecordPath("/home", "session", longProfile);
    const name = path.split("/").pop() ?? "";
    expect(name.length).toBeLessThanOrEqual(255);
    // The `~` prefix namespace is disjoint from base64url output (which never
    // contains `~`), so the fallback cannot collide with an encoded id — and
    // distinct long ids hash to distinct parts.
    expect(name).toContain("~");
    expect(ownerRecordPath("/home", "session", `${longProfile}-2`)).not.toBe(path);
  });

  test("the lock path is derived per (session, profile) just like the record path", () => {
    expect(ownerLockPath("/home", "s1", "a:b")).not.toBe(ownerLockPath("/home", "s1", "a_b"));
    expect(ownerLockPath("/home", "s1", "p").endsWith(".lock")).toBe(true);
  });
});

describe("owner-record reads", () => {
  test("a record naming a different profile reads as absent (misread defense)", () => {
    const home = openHome();
    writeRecordDirectly(home, "s1", "driffs", record({ profileId: "a_b" }));
    // Whatever path collision or tampering put a foreign record here, this
    // profile must never ack or re-claim through it.
    expect(readOwnerRecord(home, "s1", "driffs")).toBeNull();
  });

  test("a file from the old filename scheme reads as absent (re-claim, re-deliver)", () => {
    const home = openHome();
    const owners = join(home, "owners");
    mkdirSync(owners, { recursive: true });
    // Old scheme: sanitized ids, dash-joined — unreachable by the new reader.
    writeFileSync(
      join(owners, "claude-s1-a_b.json"),
      `${JSON.stringify(
        record({
          delivered: {
            ids: ["00000000-0000-4000-8000-00000000000a"],
            phase: "delivered",
            promptId: "old",
          },
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    expect(readOwnerRecord(home, "s1", "a:b")).toBeNull();
    expect(readOwnerRecord(home, "s1", "a_b")).toBeNull();
  });
});

describe("owner-record atomic replacement", () => {
  test("a write replaces the inode, lands at mode 0600 over 0644, and leaves no residue", () => {
    const home = openHome();
    const path = ownerRecordPath(home, "s1", "driffs");
    expect(
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record(),
        handled: null,
      }),
    ).toBe(true);
    const first = statSync(path);
    expect(first.mode & 0o777).toBe(0o600);

    // A hostile pre-existing mode must not survive a replacement.
    chmodSync(path, 0o644);
    expect(
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record({ leaseToken: "token-2" }),
        handled: null,
      }),
    ).toBe(true);
    const second = statSync(path);
    expect(second.mode & 0o777).toBe(0o600);
    // rename(2), never truncate-in-place: the target inode is swapped whole,
    // so a crash mid-write cannot leave a partial record behind.
    expect(second.ino).not.toBe(first.ino);
    expect(readFileSync(path, "utf8")).toContain("token-2");
    // Released locks and consumed temps: only the record itself remains.
    expect(existsSync(ownerLockPath(home, "s1", "driffs"))).toBe(false);
    const residue = (readdirSync(join(home, "owners")) ?? []).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(residue).toEqual([]);
  });

  test("a symlink planted at the record path is refused, never followed", () => {
    const home = openHome();
    mkdirSync(join(home, "owners"), { recursive: true });
    const victim = join(home, "victim");
    writeFileSync(victim, "do not touch\n");
    const path = ownerRecordPath(home, "s1", "driffs");
    symlinkSync(victim, path);

    expect(() =>
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record(),
        handled: null,
      }),
    ).toThrow(OwnerFileStorageError);
    // The planted link still stands and the victim is untouched.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do not touch\n");
  });
});

describe("owner-record compare-and-swap", () => {
  test("a moved record refuses the swap: the newer record is left alone", () => {
    const home = openHome();
    const handled: HandledRecord = { ids: ["id-1"], leaseToken: "token-1" };
    writeRecordDirectly(
      home,
      "s1",
      "driffs",
      record({
        delivered: { ids: ["id-1"], phase: "delivered", promptId: "p" },
        leaseToken: "token-1",
      }),
    );
    // Another invocation settled the record and replaced it in the meantime.
    writeRecordDirectly(home, "s1", "driffs", record({ leaseToken: "token-2" }));
    expect(
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record({ leaseToken: "token-3" }),
        handled,
      }),
    ).toBe(false);
    // The stale write never landed: token-2's record survives byte-for-byte.
    expect(readFileSync(ownerRecordPath(home, "s1", "driffs"), "utf8")).toContain("token-2");
  });

  test("a lock held by a live process times the CAS out within the budget and abandons", () => {
    const home = openHome();
    const lockPath = ownerLockPath(home, "s1", "driffs");
    mkdirSync(join(home, "owners"), { recursive: true });
    // Fresh lock: indistinguishable from a live holder.
    writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });

    const started = Date.now();
    expect(
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record(),
        handled: null,
      }),
    ).toBe(false);
    const elapsed = Date.now() - started;
    // Bounded: it waited (the budget), then gave up instead of blocking the turn.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(10_000);
    // Nothing was written under contention.
    expect(existsSync(ownerRecordPath(home, "s1", "driffs"))).toBe(false);
  });

  test("an orphaned lock (crashed holder) is stolen once it ages past the threshold", () => {
    const home = openHome();
    const lockPath = ownerLockPath(home, "s1", "driffs");
    mkdirSync(join(home, "owners"), { recursive: true });
    writeFileSync(lockPath, "999999\n", { mode: 0o600 });
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lockPath, stale, stale);

    expect(
      casOwnerRecord({
        homeDir: home,
        sessionId: "s1",
        profileId: "driffs",
        next: record(),
        handled: null,
      }),
    ).toBe(true);
    expect(readOwnerRecord(home, "s1", "driffs")?.leaseToken).toBe("lease-token");
    // The stolen lock was cleaned up with the transition.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("unusable storage is a classified failure carrying the profile id", () => {
    const home = openHome();
    const owners = join(home, "owners");
    mkdirSync(owners, { recursive: true });
    chmodSync(owners, 0o500);
    try {
      expect(() =>
        casOwnerRecord({
          homeDir: home,
          sessionId: "s1",
          profileId: "driffs",
          next: record(),
          handled: null,
        }),
      ).toThrow(OwnerFileStorageError);
      try {
        casOwnerRecord({
          homeDir: home,
          sessionId: "s1",
          profileId: "driffs",
          next: record(),
          handled: null,
        });
        throw new Error("expected OwnerFileStorageError");
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerFileStorageError);
        expect((error as OwnerFileStorageError).profileId).toBe("driffs");
      }
    } finally {
      chmodSync(owners, 0o700);
    }
  });
});

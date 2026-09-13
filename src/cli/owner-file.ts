import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Owner-record storage for the Claude Code hook bridge (`shepy claude-hook`).
 *
 * The owner file is the durable record that makes a stateless hook own a
 * profile across turns: it holds the lease token and the delivered-batch
 * record the next turn acks. Three properties are load-bearing and every
 * function here preserves all three:
 *
 *  - **Atomic replacement.** The record is written to a mode-0600 temporary
 *    file in the same directory, fsynced, then `rename(2)`d over the target.
 *    A reader therefore sees either the whole old record or the whole new
 *    one — a crash between truncate and write (the old in-place scheme) can
 *    no longer destroy the lease token or the ack record.
 *  - **Cross-process compare-and-swap.** Claude Code does not serialize
 *    hooks: the Stop for turn N can overlap the UserPromptSubmit for turn
 *    N+1, and two processes can both pass a read-check-then-write before
 *    either writes, silently erasing each other's record. Every transition
 *    is therefore guarded by a per-`(session, profile)` lock file created
 *    with `O_CREAT|O_EXCL` — a real cross-process mutual-exclusion
 *    primitive — and the check and the write run while it is held. The
 *    lock is BOUNDED: a hook runs inside the user's turn latency, so it
 *    must never block the editor waiting for storage. If the lock cannot
 *    be acquired within OWNER_LOCK_BUDGET_MS, the invocation abandons its
 *    batch — the rows stay leased server-side, expire, and are
 *    re-delivered. A duplicate is the accepted trade; a blocked editor is
 *    not. A crashed holder's lock is stolen once it is older than
 *    OWNER_LOCK_STALE_MS (hold times here are synchronous filesystem
 *    operations — microseconds; 2s is orders of magnitude past any real
 *    hold). The lock is never held across an RPC: it covers only the
 *    read-check-write transition.
 *  - **Collision-free keys.** The filename derives from base64url of the
 *    UTF-8 session and profile ids joined by a "." (which cannot occur in
 *    base64url). The old scheme sanitized ids into `[A-Za-z0-9_-]`, which
 *    mapped distinct profile ids — the schema allows any non-empty string,
 *    so `a:b` and `a_b` are both valid — onto ONE file: two profiles
 *    sharing an owner record, each acking through the other's identity.
 *    Encoded parts longer than ENCODED_PART_MAX fall back to `~` + SHA-256
 *    hex to stay under filesystem filename limits; `~` is outside the
 *    base64url alphabet, so the two namespaces cannot collide. A file
 *    written under the OLD scheme lives at a different path and reads as
 *    absent: the hook re-claims and the rows re-deliver — a duplicate,
 *    never a misread. As defense in depth, a record whose embedded
 *    `profileId` does not match the requested profile is also treated as
 *    absent, so no path collision can ever make one profile ack through
 *    another profile's record.
 *
 * Hard rules inherited from the hook: every storage failure is an
 * OwnerFileStorageError — expected, exit 0, operator-facing warning — and a
 * `"leased"`-phase record is never acked (the caller owns that rule; this
 * module only guarantees that transitions are atomic, exclusive, and
 * durable).
 */

/** Per-request lock-acquisition budget — bounded so a hook never blocks a turn. */
export const OWNER_LOCK_BUDGET_MS = 500;
/** A lock older than this was left by a crashed holder and is stolen. */
const OWNER_LOCK_STALE_MS = 2_000;
/** Poll interval while waiting on a contended lock. */
const OWNER_LOCK_POLL_MS = 5;
/** Worst-case encoded filename stays under the 255-byte filesystem limit. */
const ENCODED_PART_MAX = 112;

const ownerRecordSchema = Type.Object(
  {
    delivered: Type.Union([
      Type.Null(),
      Type.Object(
        {
          ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          // Two-phase commit marker. "leased" = the batch was leased and this
          // record written, but inbox.delivered has NOT committed: nobody has
          // seen these outcomes. "delivered" = the daemon accepted the batch
          // and the hook injected it: safe to ack. `phase` is REQUIRED on
          // purpose — a record written by an earlier round (no phase) fails
          // this schema, reads back as null, and is discarded WITHOUT acking,
          // which is the only safe reading of an unknown record. Never
          // "upgrade" a phase-less record to delivered.
          phase: Type.Union([Type.Literal("leased"), Type.Literal("delivered")]),
          promptId: Type.Union([Type.Null(), Type.String({ minLength: 1 })]),
        },
        { additionalProperties: false },
      ),
    ]),
    // Consecutive post-lease delivery-handoff failures: the ids of the last
    // failed batch and how many turns in a row a batch sharing those ids has
    // failed. Optional — absent on every healthy and phase-1/phase-2 record.
    failedDelivery: Type.Optional(
      Type.Object(
        {
          attempts: Type.Integer({ minimum: 1 }),
          ids: Type.Array(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    leaseToken: Type.String({ minLength: 1 }),
    ownerSessionRefJson: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type OwnerRecord = {
  delivered: {
    ids: string[];
    phase: "leased" | "delivered";
    promptId: string | null;
  } | null;
  failedDelivery?: { attempts: number; ids: string[] } | undefined;
  leaseToken: string;
  ownerSessionRefJson: string;
  profileId: string;
};

/**
 * The record an invocation has already settled (acked or discarded): its
 * lease token and batch ids. Null means the invocation expects no unsettled
 * record on disk at all.
 */
export type HandledRecord = { ids: string[]; leaseToken: string } | null;

/**
 * A classified storage failure: expected, so the hook exits 0 for it and
 * surfaces the operator warning. The hook renders the user-facing line (it
 * owns the untrusted-text policy); this class carries the profile id and the
 * underlying reason.
 */
export class OwnerFileStorageError extends Error {
  readonly profileId: string;

  constructor(message: string, profileId: string) {
    super(message);
    this.name = "OwnerFileStorageError";
    this.profileId = profileId;
  }
}

/**
 * One-line-safe rendering of untrusted-ish text (profile ids from argv, pane
 * ids and harness kinds from the daemon) for user-facing warning lines:
 * control bytes and line separators become spaces so a value can never forge
 * additional lines in the systemMessage.
 */
export function plainText(value: string | null | undefined, max = 64): string {
  const collapsed = (value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional stripping — untrusted values must never carry control bytes or line breaks into a user-facing warning line
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return "unknown";
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Collision-free filename part. base64url of the UTF-8 bytes is injective;
 * parts too long for a filename fall back to `~` + SHA-256 hex, and `~` is
 * outside the base64url alphabet so the fallback namespace is disjoint.
 */
function encodeKeyPart(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  if (encoded.length <= ENCODED_PART_MAX) return encoded;
  return `~${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * The owner record path for one (session, profile) pair. Distinct pairs
 * cannot map to the same file: the parts are injectively encoded and joined
 * with ".", which never occurs in base64url output.
 */
export function ownerRecordPath(homeDir: string, sessionId: string, profileId: string): string {
  return join(
    homeDir,
    "owners",
    `claude-${encodeKeyPart(sessionId)}.${encodeKeyPart(profileId)}.json`,
  );
}

/** The per-(session, profile) mutual-exclusion lock guarding record transitions. */
export function ownerLockPath(homeDir: string, sessionId: string, profileId: string): string {
  return join(
    homeDir,
    "owners",
    `claude-${encodeKeyPart(sessionId)}.${encodeKeyPart(profileId)}.lock`,
  );
}

export function readOwnerRecord(
  homeDir: string,
  sessionId: string,
  profileId: string,
  warnings: string[] = [],
): OwnerRecord | null {
  let raw: string;
  try {
    raw = readFileSync(ownerRecordPath(homeDir, sessionId, profileId), "utf8");
  } catch (error) {
    // Missing is the normal state (first turn, stateless recovery, a record
    // stranded under the old filename scheme). Any other read failure is a
    // storage problem the operator should hear about.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `shepy: cannot read the shepy owner file for profile ${plainText(profileId)}; a pending ack record was ignored`,
      );
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Value.Check(ownerRecordSchema, parsed)) return null;
    const record = parsed as OwnerRecord;
    // A record naming a different profile is not this profile's record —
    // treat it as absent rather than acking or re-claiming through it. This
    // is what makes any historical or pathological path collision merely a
    // duplicate delivery instead of a cross-profile identity theft.
    if (record.profileId !== profileId) return null;
    return record;
  } catch {
    return null;
  }
}

function sameUnsettledRecord(current: OwnerRecord | null, handled: HandledRecord): boolean {
  const currentDelivered = current?.delivered ?? null;
  if (handled === null) return currentDelivered === null;
  if (currentDelivered === null) return false;
  return (
    current?.leaseToken === handled.leaseToken &&
    currentDelivered.ids.length === handled.ids.length &&
    currentDelivered.ids.every((id, index) => id === handled.ids[index])
  );
}

function serializeOwnerRecord(record: OwnerRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function writeAllSync(fd: number, payload: string): void {
  const buffer = Buffer.from(payload, "utf8");
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
}

// Test-only fault injection, exercised by the cross-process durability tests.
// Both knobs default to off and are never set outside those tests.
const CAS_WINDOW_PAUSE_MS = parseTestPauseMs(process.env.SHEPY_HOOK_TEST_CAS_PAUSE_MS);
const CRASH_PAUSE_POINT = parseCrashPausePoint(process.env.SHEPY_HOOK_TEST_WRITE_PAUSE);

function parseTestPauseMs(raw: string | undefined): number {
  const parsed = Number(raw ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 10_000) : 0;
}

function parseCrashPausePoint(raw: string | undefined): "after-rename" | "before-rename" | null {
  if (raw === "before-rename" || raw === "after-rename") return raw;
  return null;
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Blocks the event loop forever — a real-process crash is simulated by SIGKILL. */
function blockUntilKilled(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.POSITIVE_INFINITY);
}

/**
 * Atomic record replacement: write a fresh mode-0600 temporary file in the
 * target directory, fsync it, then rename(2) it over the target. rename
 * within a directory is atomic, so a concurrent reader — or a crash at ANY
 * point — leaves either the whole old record or the whole new one on disk,
 * never a truncated hybrid. The temp file is created at 0600 (never created
 * permissively and fixed afterwards) and re-chmod'd before the rename so a
 * hostile umask cannot leak group/other bits; O_NOFOLLOW on the temp plus
 * the explicit symlink refusal below preserve the old rule that a planted
 * symlink at the owner-file path is never written through.
 */
function writeOwnerRecordAtomic(path: string, payload: string): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Anything already at the target is replaced wholesale by the rename below
  // — EXCEPT a symlink: refuse it the way the old O_NOFOLLOW open did, so a
  // planted link is an operator-visible storage failure and its victim file
  // is never touched. (Even if a link were planted in the microseconds after
  // this check, rename would replace the LINK itself, never follow it — the
  // victim stays safe either way; the check preserves the loud failure.)
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("owner file path is a symlink");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "owner file path is a symlink") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`owner file path unusable: ${describeError(error)}`);
    }
  }
  const fd = openSync(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeAllSync(fd, payload);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (CRASH_PAUSE_POINT === "before-rename") blockUntilKilled();
  renameSync(tempPath, path);
  if (CRASH_PAUSE_POINT === "after-rename") blockUntilKilled();
}

/**
 * Acquire the per-(session, profile) record lock: an O_CREAT|O_EXCL file is
 * the cross-process mutex. Contention is polled for at most
 * OWNER_LOCK_BUDGET_MS (null on timeout — callers abandon the batch), a
 * holder that crashed is stolen after OWNER_LOCK_STALE_MS, and any
 * non-contention error is a storage failure. Runs synchronously; hold times
 * are filesystem-operation-scale, so the poll is a handful of iterations.
 */
function acquireOwnerLock(lockPath: string, profileId: string): number | null {
  const deadline = Date.now() + OWNER_LOCK_BUDGET_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OwnerFileStorageError(
          `owner record lock unusable: ${describeError(error)}`,
          profileId,
        );
      }
      if (Date.now() >= deadline) return null;
      // Contended. A lock far older than any real hold belongs to a crashed
      // hook: steal it so one kill -9 cannot mute a pane forever. Losing the
      // steal race is harmless — the next iteration re-checks.
      try {
        const held = statSync(lockPath);
        if (Date.now() - held.mtimeMs > OWNER_LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Someone else stole it first; just retry the create.
          }
          continue;
        }
      } catch {
        // Vanished between the create attempt and the stat: retry now.
        continue;
      }
      syncSleep(OWNER_LOCK_POLL_MS);
      continue;
    }
    // The pid inside is diagnostics for operators, not the mutex itself —
    // the mutex is the O_EXCL directory entry.
    try {
      writeSync(fd, `${process.pid}\n`);
    } catch {
      // Best-effort annotation only.
    }
    return fd;
  }
}

function releaseOwnerLock(lockPath: string, fd: number): void {
  // If the link count is zero our lock was stolen out from under us while
  // held (it should be impossible — holds are microseconds) and the path now
  // belongs to someone else: close, but do not unlink their lock.
  let stillOurs = true;
  try {
    stillOurs = fstatSync(fd).nlink > 0;
  } catch {
    stillOurs = false;
  }
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
  if (stillOurs) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The atomic compare-and-swap on the owner record: under the per-record
 * lock, re-read the on-disk state and write `next` only if it is still
 * exactly the record this invocation settled (or there is no unsettled
 * record to protect). The lock makes the read-check-write indivisible
 * across processes — without it, two hook processes could both pass the
 * check before either wrote, and the later write would erase a record it
 * never settled. Never hold across an RPC: callers run their daemon round
 * trips outside this function.
 *
 * Returns false when the record moved (another invocation owns it now) or
 * the lock could not be acquired within the budget (storage contention —
 * the caller abandons its batch; the rows stay leased, expire, and
 * re-deliver). Throws OwnerFileStorageError on unusable storage, which the
 * hook reports to the operator and exits 0.
 */
export function casOwnerRecord(input: {
  homeDir: string;
  sessionId: string;
  profileId: string;
  next: OwnerRecord;
  handled: HandledRecord;
}): boolean {
  const { homeDir, sessionId, profileId, next, handled } = input;
  const path = ownerRecordPath(homeDir, sessionId, profileId);
  const lockPath = ownerLockPath(homeDir, sessionId, profileId);
  try {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  } catch (error) {
    throw new OwnerFileStorageError(
      `owners directory unusable: ${describeError(error)}`,
      profileId,
    );
  }
  const lockFd = acquireOwnerLock(lockPath, profileId);
  if (lockFd === null) return false;
  try {
    if (!sameUnsettledRecord(readOwnerRecord(homeDir, sessionId, profileId), handled)) {
      return false;
    }
    if (CAS_WINDOW_PAUSE_MS > 0) syncSleep(CAS_WINDOW_PAUSE_MS);
    writeOwnerRecordAtomic(path, serializeOwnerRecord(next));
    return true;
  } catch (error) {
    if (error instanceof OwnerFileStorageError) throw error;
    throw new OwnerFileStorageError(`owner file unwritable: ${describeError(error)}`, profileId);
  } finally {
    releaseOwnerLock(lockPath, lockFd);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

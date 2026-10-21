import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryRef, AgentSessionRef } from "@/observability/contracts.js";

/**
 * Header metadata is extracted from a bounded prefix, never a full read of
 * potentially huge transcripts. Identity fields (sessionId, cwd) live on the
 * first records of every supported format; if they do not appear within the
 * bound the candidate honestly resolves without identity.
 */
const HEADER_READ_BYTES = 128 * 1024;
const GEMINI_METADATA_READ_BYTES = 1024 * 1024;

export type AgentHistoryLookupInput = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  homeDir?: string;
  candidateCache?: AgentHistoryCandidateCache;
};

export type AgentHistoryCandidateCache = Map<
  string,
  {
    fingerprint: string;
    metadata: { cwd: string | null; sessionId: string | null };
  }
>;

type Candidate = {
  cwd: string | null;
  path: string;
  sessionId: string | null;
  source: AgentHistoryRef["source"];
};

export async function discoverAgentHistory(
  input: AgentHistoryLookupInput,
): Promise<AgentHistoryRef | null> {
  if (input.agentSession?.kind === "path") {
    // Pi reports the path before its first prompt creates the file. Missing
    // history is honest; another same-cwd session is not a substitute.
    if (!existsSync(input.agentSession.value)) return null;
    const source = historySourceFromSessionRef(input.agentSession);
    return {
      kind: "agent_session",
      path: input.agentSession.value,
      source,
      value: input.agentSession.value,
    };
  }

  // A cwd is shared by concurrent agents. Without native identity even a
  // same-directory newest transcript is somebody else's potential session.
  if (!input.agentSession) return null;

  const cwd = input.cwd ?? input.foregroundCwd;
  const homeDir = input.homeDir ?? process.env.HOME ?? "";

  if (input.agentSession?.kind === "id") {
    const source = historySourceFromSessionRef(input.agentSession);
    if (source === "opencode-sqlite") {
      const ref = discoverOpenCodeSession({ homeDir, sessionId: input.agentSession.value });
      return ref ? { ...ref, kind: "agent_session" } : null;
    }
    if (source === "hermes-sqlite") {
      const ref = discoverHermesSession({ homeDir, sessionId: input.agentSession.value });
      return ref;
    }
  }

  const agent = input.agent?.toLowerCase() ?? input.agentSession?.agent.toLowerCase() ?? "";
  const candidates: Candidate[] = [];
  if (agent === "pi") {
    candidates.push(
      ...(await scanRoot(
        join(homeDir, ".pi", "agent", "sessions"),
        "pi-jsonl",
        input.candidateCache,
      )),
    );
  }
  if (agent === "claude") {
    candidates.push(
      ...(await scanRoot(
        join(homeDir, ".claude", "projects"),
        "claude-jsonl",
        input.candidateCache,
      )),
    );
  }
  if (agent === "codex") {
    candidates.push(
      ...(await scanRoot(join(homeDir, ".codex", "sessions"), "codex-jsonl", input.candidateCache)),
    );
  }
  if (agent === "gemini") {
    candidates.push(...(await scanGeminiRoot(join(homeDir, ".gemini", "tmp"))));
  }
  if (agent === "opencode") {
    // A directory can hold many sessions. Only a native exact ID is a binding;
    // the agent process's environment is not the Shepy process environment.
    return null;
  }
  if (input.agentSession?.kind === "id") {
    const session = input.agentSession;
    const exact = candidates.filter((candidate) => candidate.sessionId === session.value);
    // Claude Code writes subagent transcripts under
    // <project>/<parent-id>/subagents/ that carry the PARENT sessionId on
    // every record. An exact header match that is a subagent copy is never
    // the canonical main transcript. A resumed main can exist in several
    // project folders, with the original cwd still in its header. Select
    // only a unique main in the current project folder, never by mtime.
    const mains = exact.filter((candidate) => !isSubagentTranscriptPath(candidate.path));
    const local = mains.filter((candidate) => candidateInProject(candidate, cwd, homeDir));
    const match = mains.length === 1 ? mains[0] : local.length === 1 ? local[0] : undefined;
    return match
      ? { kind: "agent_session", path: match.path, source: match.source, value: session.value }
      : null;
  }
  return null;
}

function candidateInProject(
  candidate: Pick<Candidate, "path" | "source" | "cwd">,
  cwd: string | null,
  homeDir: string,
): boolean {
  if (!cwd) return false;
  if (candidate.source === "claude-jsonl") {
    return (
      dirname(candidate.path) ===
      join(homeDir, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
    );
  }
  if (candidate.source === "pi-jsonl") {
    const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return dirname(candidate.path) === join(homeDir, ".pi", "agent", "sessions", slug);
  }
  return candidate.cwd === cwd;
}

export function historySourceFromSessionRef(ref: AgentSessionRef): AgentHistoryRef["source"] {
  const agent = ref.agent.toLowerCase();
  const source = ref.source.toLowerCase();
  if (agent === "pi" || source.includes("pi")) return "pi-jsonl";
  if (agent === "claude" || source.includes("claude")) return "claude-jsonl";
  if (agent === "codex" || source.includes("codex")) return "codex-jsonl";
  if (agent === "hermes" || source.includes("hermes")) return "hermes-sqlite";
  if (agent === "opencode" || source.includes("opencode")) return "opencode-sqlite";
  if (agent === "gemini" || source.includes("gemini")) return "gemini-json";
  return "unknown";
}

/**
 * Resolve a Hermes session id to its store.
 *
 * Deliberately has no cwd fallback. Hermes sessions are not unique per
 * directory — 92 sessions share `/Users/ray/dev/driffs` on this machine — so
 * "newest session in this cwd" would silently attach an orchestrator to the
 * wrong worker. Without an exact id reported by the pane, this returns null
 * and the agent stays history-less, which is the honest outcome.
 */
export function discoverHermesSession(input: {
  homeDir: string;
  sessionId: string;
}): AgentHistoryRef | null {
  if (!input.sessionId) return null;
  const dbPath = hermesStatePath(input.homeDir);
  if (!existsSync(dbPath)) return null;

  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    const row = sqlite
      .prepare("select id from sessions where id = ? limit 1")
      .get(input.sessionId) as unknown as { id: string } | undefined;
    if (!row?.id) return null;
    return { kind: "agent_session", path: dbPath, source: "hermes-sqlite", value: row.id };
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function hermesStatePath(homeDir: string): string {
  const override = process.env.HERMES_HOME;
  return override ? join(override, "state.db") : join(homeDir, ".hermes", "state.db");
}

async function scanRoot(
  root: string,
  source: AgentHistoryRef["source"],
  cache?: AgentHistoryCandidateCache,
): Promise<Candidate[]> {
  const files = await listJsonlFiles(root);
  const candidates: Candidate[] = [];
  const present = new Set(files);
  for (const path of files) {
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) continue;
    const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const previous = cache?.get(path);
    const metadata =
      previous?.fingerprint === fingerprint ? previous.metadata : await readCandidateMetadata(path);
    // Re-enumerate and stat every candidate so new resumed copies are seen,
    // but do not reopen hundreds of unchanged headers for one cached ID.
    // A transient unreadable header is never memoized as missing identity.
    if (metadata.sessionId) cache?.set(path, { fingerprint, metadata });
    else cache?.delete(path);
    candidates.push({ ...metadata, path, source });
  }
  for (const path of cache?.keys() ?? []) {
    if (path.startsWith(`${root}${sep}`) && !present.has(path)) cache?.delete(path);
  }
  return candidates;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsonlFiles(path)));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function readCandidateMetadata(
  path: string,
): Promise<{ cwd: string | null; sessionId: string | null }> {
  const content = await readHeaderPrefix(path, HEADER_READ_BYTES);
  if (content === null) return { cwd: null, sessionId: null };
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let inspected = 0;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    if (inspected++ >= 100) break;
    try {
      const record = recordValue(JSON.parse(line));
      const payload = recordValue(record.payload);
      const message = recordValue(record.message);
      cwd ??=
        stringValue(record.cwd) ??
        stringValue(record.foreground_cwd) ??
        stringValue(payload.cwd) ??
        stringValue(payload.foreground_cwd) ??
        stringValue(message.cwd) ??
        stringValue(message.foreground_cwd);
      // Claude: sessionId on messages; Pi: session header id; Codex:
      // session_meta payload.id. Ordinary message IDs are NOT session IDs.
      sessionId ??=
        stringValue(record.sessionId) ??
        (record.type === "session" ? stringValue(record.id) : null) ??
        (record.type === "session_meta" ? stringValue(payload.id) : null);
      if (cwd && sessionId) break;
    } catch {}
  }
  return { cwd, sessionId };
}

async function scanGeminiRoot(root: string): Promise<Candidate[]> {
  if (!existsSync(root)) return [];
  const projectDirs = await listGeminiProjectDirs(root);
  const candidates: Candidate[] = [];
  for (const projectDir of projectDirs) {
    const cwd =
      (
        (await readHeaderPrefix(join(projectDir, ".project_root"), HEADER_READ_BYTES)) ?? ""
      ).trim() || null;
    const sessions = await listGeminiSessionFiles(join(projectDir, "chats"));
    for (const path of sessions) {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      const session = await readHeaderPrefix(path, GEMINI_METADATA_READ_BYTES)
        .then((prefix) => (prefix === null ? null : recordValue(safeJsonParse(prefix))))
        .catch(() => null);
      candidates.push({
        cwd,
        sessionId: stringValue(session?.sessionId),
        path,
        source: "gemini-json",
      });
    }
  }
  return candidates;
}

async function listGeminiProjectDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(path, ".project_root"))) dirs.push(path);
  }
  return dirs;
}

async function listGeminiSessionFiles(chatsDir: string): Promise<string[]> {
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".json"),
    )
    .map((entry) => join(chatsDir, entry.name));
}

function discoverOpenCodeSession(input: {
  homeDir: string;
  sessionId: string;
}): AgentHistoryRef | null {
  if (!input.sessionId) return null;
  const dbPath = resolveOpenCodeDbPath(input.homeDir);
  if (!existsSync(dbPath)) return null;
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    // Probe both families by exact ID. An absent table is normal during a
    // version transition; a broken present table is not a successful lookup.
    const tables = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name in ('session', 'session_v2')",
      )
      .all() as { name: string }[];
    for (const table of ["session_v2", "session"]) {
      if (!tables.some((row) => row.name === table)) continue;
      const row = sqlite
        .prepare(`select id from ${table} where id = ? limit 1`)
        .get(input.sessionId) as { id: string } | undefined;
      if (row?.id)
        return { kind: "agent_session", path: dbPath, source: "opencode-sqlite", value: row.id };
    }
    return null;
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function resolveOpenCodeDbPath(homeDir: string): string {
  const override = process.env.OPENCODE_DB;
  if (override && override !== ":memory:") {
    return override.startsWith("/")
      ? override
      : join(homeDir, ".local", "share", "opencode", override);
  }
  return join(homeDir, ".local", "share", "opencode", "opencode.db");
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True for transcript copies stored under a `subagents` directory. */
function isSubagentTranscriptPath(path: string): boolean {
  return path.split(/[\\/]/).includes("subagents");
}

/**
 * Read at most `limitBytes` from the head of a file. Returns the decoded
 * prefix truncated to the last complete line (the tail partial line is
 * dropped), or null when the file cannot be opened.
 */
async function readHeaderPrefix(path: string, limitBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(limitBytes);
    const { bytesRead } = await handle.read(buffer, 0, limitBytes, 0);
    if (bytesRead <= 0) return "";
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (bytesRead < limitBytes) return text;
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Validate that a cached history hint really belongs to the exact session
 * Herdr reported. Value/source/kind equality alone is NOT sufficient: the
 * pre-fix binder stamped the requested id onto whatever file discovery
 * found. File-backed sources re-read the hint file's header (bounded) and
 * require the identity to come from the file itself; SQLite sources re-run
 * the exact session probe so a shared database keeps per-session identity.
 */
export async function hintMatchesAgentSession(input: {
  candidateCache?: AgentHistoryCandidateCache;
  cwd?: string | null;
  hint: AgentHistoryRef;
  homeDir: string;
  session: AgentSessionRef;
}): Promise<boolean> {
  const source = historySourceFromSessionRef(input.session);
  if (input.hint.kind !== "agent_session") return false;
  if (input.hint.source !== source) return false;
  if (input.session.kind === "path") {
    return input.hint.path === input.session.value;
  }
  if (input.hint.value !== input.session.value) return false;
  if (source === "opencode-sqlite") {
    const ref = discoverOpenCodeSession({
      homeDir: input.homeDir,
      sessionId: input.session.value,
    });
    return ref !== null && (input.hint.path ?? input.hint.value) === ref.path;
  }
  if (source === "hermes-sqlite") {
    const ref = discoverHermesSession({ homeDir: input.homeDir, sessionId: input.session.value });
    return ref !== null && input.hint.path === ref.path;
  }
  if (source === "unknown") return false;
  const path = input.hint.path;
  if (!path || isSubagentTranscriptPath(path)) return false;
  const metadata = await readCandidateMetadata(path);
  if (metadata.sessionId !== input.session.value) return false;
  // Cwd aliases do not invalidate a unique native session. Only multiple
  // genuine mains require the project-folder rule; never guess by mtime.
  if (
    source === "claude-jsonl" &&
    !candidateInProject({ path, source, cwd: metadata.cwd }, input.cwd ?? null, input.homeDir)
  ) {
    const mains = (
      await scanRoot(join(input.homeDir, ".claude", "projects"), source, input.candidateCache)
    ).filter(
      (candidate) =>
        candidate.sessionId === input.session.value && !isSubagentTranscriptPath(candidate.path),
    );
    const mainCount = mains.length + (mains.some((candidate) => candidate.path === path) ? 0 : 1);
    if (mainCount > 1) return false;
  }
  return true;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentHistoryRef, AgentSessionRef } from "@/observability/contracts.js";

export type AgentHistoryLookupInput = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  cwd: string | null;
  foregroundCwd: string | null;
  homeDir?: string;
};

type Candidate = {
  cwd: string | null;
  mtimeMs: number;
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

  const cwd = input.cwd ?? input.foregroundCwd;
  const homeDir = input.homeDir ?? process.env.HOME ?? "";

  if (input.agentSession?.kind === "id") {
    const source = historySourceFromSessionRef(input.agentSession);
    if (source === "opencode-sqlite") {
      const ref = discoverOpenCodeSession({ cwd, homeDir, sessionId: input.agentSession.value });
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
    candidates.push(...(await scanRoot(join(homeDir, ".pi", "agent", "sessions"), "pi-jsonl")));
  }
  if (agent === "claude") {
    candidates.push(...(await scanRoot(join(homeDir, ".claude", "projects"), "claude-jsonl")));
  }
  if (agent === "codex") {
    candidates.push(...(await scanRoot(join(homeDir, ".codex", "sessions"), "codex-jsonl")));
  }
  if (agent === "gemini") {
    candidates.push(...(await scanGeminiRoot(join(homeDir, ".gemini", "tmp"))));
  }
  if (agent === "opencode") {
    const ref = discoverOpenCodeSession({ cwd, homeDir, sessionId: null });
    if (ref) return ref;
  }
  if (input.agentSession?.kind === "id") {
    const session = input.agentSession;
    const exact = candidates.filter((candidate) => candidate.sessionId === session.value);
    // IDs are authority, not hints for cwd ranking. Ambiguous copies and
    // unavailable sessions stay unresolved rather than inventing a binding.
    const match = exact.length === 1 ? exact[0] : undefined;
    return match
      ? { kind: "agent_session", path: match.path, source: match.source, value: session.value }
      : null;
  }
  const ranked = candidates.sort((a, b) => {
    const aMatch = cwd && a.cwd === cwd ? 1 : 0;
    const bMatch = cwd && b.cwd === cwd ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
  const best = ranked[0];
  return best
    ? { kind: "discovered_file", path: best.path, source: best.source, value: best.path }
    : null;
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

async function scanRoot(root: string, source: AgentHistoryRef["source"]): Promise<Candidate[]> {
  if (!existsSync(root)) return [];
  const files = await listJsonlFiles(root);
  const candidates: Candidate[] = [];
  for (const path of files) {
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) continue;
    candidates.push({
      ...(await readCandidateMetadata(path)),
      mtimeMs: stats.mtimeMs,
      path,
      source,
    });
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
  const content = await readFile(path, "utf8").catch(() => "");
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
      (await readFile(join(projectDir, ".project_root"), "utf8").catch(() => "")).trim() || null;
    const sessions = await listGeminiSessionFiles(join(projectDir, "chats"));
    for (const path of sessions) {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) continue;
      const session = await readFile(path, "utf8")
        .then((text) => recordValue(JSON.parse(text)))
        .catch(() => recordValue(null));
      candidates.push({
        cwd,
        sessionId: stringValue(session.sessionId),
        mtimeMs: stats.mtimeMs,
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
  cwd: string | null;
  homeDir: string;
  sessionId: string | null;
}): AgentHistoryRef | null {
  const dbPath = resolveOpenCodeDbPath(input.homeDir);
  if (!existsSync(dbPath)) return null;
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(dbPath, { readOnly: true });
    if (input.sessionId) {
      const row = sqlite
        .prepare("select id from session where id = ? limit 1")
        .get(input.sessionId) as { id: string } | undefined;
      return row
        ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id }
        : null;
    }
    if (!input.cwd) return null;
    const row = sqlite
      .prepare("select id from session where directory = ? order by time_updated desc limit 1")
      .get(input.cwd) as { id: string } | undefined;
    return row
      ? { kind: "discovered_file", path: dbPath, source: "opencode-sqlite", value: row.id }
      : null;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

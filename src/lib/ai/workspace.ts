import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { db } from "@/lib/db/client";
import { conversationSummaries, memories } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { TOOL_CATALOG } from "@/lib/ai/tools/catalog";

export const WORKSPACE_DIR = join(homedir(), ".nicole");
const SKILLS_DIR = join(WORKSPACE_DIR, "skills");
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");

const WORKSPACE_FILE_ALIASES = {
  agents: ["AGENTS.md", "agents.md"],
  soul: ["SOUL.md", "soul.md"],
  tools: ["TOOLS.md", "tools.md"],
  identity: ["IDENTITY.md", "identity.md"],
  user: ["USER.md", "user.md"],
  memory: ["MEMORY.md", "memory.md", "memory/index.md"],
  boot: ["BOOT.md", "boot.md"],
  bootstrap: ["BOOTSTRAP.md", "bootstrap.md"],
  heartbeat: ["HEARTBEAT.md", "heartbeat.md"],
  context: ["CONTEXT.md", "context.md"],
} as const;

type WorkspaceDocumentKey = keyof typeof WORKSPACE_FILE_ALIASES;

interface CachedWorkspaceDocument {
  path: string;
  mtime: number;
  content: string;
}

export interface WorkspaceDocument {
  key: WorkspaceDocumentKey;
  path: string;
  content: string;
}

export interface WorkspacePromptLayer {
  key: WorkspaceDocumentKey | "dailyMemory";
  title: string;
  content: string;
}

export type WorkspaceDocumentAuthority =
  | "control_plane"
  | "generated_mirror"
  | "runtime_state";

export interface WorkspaceDocumentDefinition {
  key: WorkspaceDocumentKey;
  aliases: readonly string[];
  authority: WorkspaceDocumentAuthority;
  title: string;
  writableByNicole: boolean;
  injectedIntoPrompt: boolean;
  description: string;
}

export interface SkillDefinition {
  name: string;
  content: string;
}

const cachedDocuments = new Map<string, CachedWorkspaceDocument>();
const generatedWorkspaceSyncTimes = new Map<WorkspaceDocumentKey, number>();
const GENERATED_WORKSPACE_SYNC_INTERVAL_MS = 60_000;

const WORKSPACE_DOCUMENT_DEFINITIONS: WorkspaceDocumentDefinition[] = [
  {
    key: "agents",
    aliases: WORKSPACE_FILE_ALIASES.agents,
    authority: "control_plane",
    title: "Behavior rules",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Nicole's machine-level behavior rules.",
  },
  {
    key: "soul",
    aliases: WORKSPACE_FILE_ALIASES.soul,
    authority: "control_plane",
    title: "Soul",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Nicole's core personality and selfhood.",
  },
  {
    key: "tools",
    aliases: WORKSPACE_FILE_ALIASES.tools,
    authority: "generated_mirror",
    title: "Workspace tool contract",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Generated mirror of the real executable tool registry.",
  },
  {
    key: "identity",
    aliases: WORKSPACE_FILE_ALIASES.identity,
    authority: "control_plane",
    title: "Identity file",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Machine-level identity notes for Nicole.",
  },
  {
    key: "user",
    aliases: WORKSPACE_FILE_ALIASES.user,
    authority: "control_plane",
    title: "User profile",
    writableByNicole: true,
    injectedIntoPrompt: true,
    description: "Curated profile of Roy.",
  },
  {
    key: "memory",
    aliases: WORKSPACE_FILE_ALIASES.memory,
    authority: "generated_mirror",
    title: "Workspace memory",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Generated memory mirror derived from database memory and summaries.",
  },
  {
    key: "boot",
    aliases: WORKSPACE_FILE_ALIASES.boot,
    authority: "control_plane",
    title: "Bootstrap",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Startup/bootstrap instructions.",
  },
  {
    key: "bootstrap",
    aliases: WORKSPACE_FILE_ALIASES.bootstrap,
    authority: "control_plane",
    title: "Bootstrap details",
    writableByNicole: false,
    injectedIntoPrompt: true,
    description: "Additional workspace boot instructions.",
  },
  {
    key: "heartbeat",
    aliases: WORKSPACE_FILE_ALIASES.heartbeat,
    authority: "control_plane",
    title: "Heartbeat",
    writableByNicole: false,
    injectedIntoPrompt: false,
    description: "Proactive behavior and polling config.",
  },
  {
    key: "context",
    aliases: WORKSPACE_FILE_ALIASES.context,
    authority: "runtime_state",
    title: "Workspace state",
    writableByNicole: true,
    injectedIntoPrompt: true,
    description: "Nicole's machine-level runtime context and state.",
  },
];

const WORKSPACE_PROMPT_LAYER_SPECS: Array<{
  key: WorkspaceDocumentKey;
  title: string;
  note?: string;
}> = [
  {
    key: "boot",
    title: "Bootstrap",
    note: "Startup/bootstrap instructions from Nicole's machine-level workspace.",
  },
  {
    key: "bootstrap",
    title: "Bootstrap details",
    note: "Additional workspace boot instructions.",
  },
  {
    key: "agents",
    title: "Behavior rules",
    note: "Workspace-level behavior guidance. Treat this as part of Nicole's operating style.",
  },
  {
    key: "identity",
    title: "Identity file",
    note: "Machine-level identity notes for Nicole.",
  },
  {
    key: "user",
    title: "User profile",
    note: "Workspace-level profile for Roy. Use it naturally; do not quote it mechanically.",
  },
  {
    key: "memory",
    title: "Workspace memory",
    note: "File-based workspace memory. Use it alongside retrieved database memory, not instead of it.",
  },
  {
    key: "context",
    title: "Workspace state",
    note: "Nicole's own machine-level context and current state.",
  },
  {
    key: "tools",
    title: "Workspace tool contract",
    note: "Workspace-level tool philosophy and intended tool map. The runtime catalog is still the source of which tools are actually executable right now.",
  },
];

const WRITABLE_WORKSPACE_DOCUMENT_KEYS = new Set<WorkspaceDocumentKey>(["user", "context"]);

function sanitizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/(?:^|\/)\.\.(?=\/|$)/g, "");
}

function stripMarkdownTitle(raw: string): string {
  return raw.replace(/^#\s+[^\n]+\n+/u, "").trim();
}

function getAliasCandidatesForPath(relativePath: string): string[] {
  const normalized = sanitizeRelativePath(relativePath);
  const lowered = normalized.toLowerCase();

  for (const candidates of Object.values(WORKSPACE_FILE_ALIASES)) {
    if (candidates.some((candidate) => candidate.toLowerCase() === lowered)) {
      return Array.from(new Set([normalized, ...candidates]));
    }
  }

  return [normalized];
}

function getDocumentKeyForPath(relativePath: string): WorkspaceDocumentKey | null {
  const normalized = sanitizeRelativePath(relativePath).toLowerCase();

  for (const [key, candidates] of Object.entries(WORKSPACE_FILE_ALIASES)) {
    if (candidates.some((candidate) => candidate.toLowerCase() === normalized)) {
      return key as WorkspaceDocumentKey;
    }
  }

  return null;
}

async function readCachedWorkspacePath(
  relativeCandidates: string[]
): Promise<{ path: string; content: string } | null> {
  for (const candidate of relativeCandidates) {
    const fullPath = join(WORKSPACE_DIR, candidate);
    if (!fullPath.startsWith(WORKSPACE_DIR)) {
      continue;
    }

    try {
      const fileStat = await stat(fullPath);
      const cached = cachedDocuments.get(fullPath);

      if (cached && cached.mtime === fileStat.mtimeMs) {
        return { path: candidate, content: cached.content };
      }

      const content = await readFile(fullPath, "utf-8");
      cachedDocuments.set(fullPath, {
        path: candidate,
        mtime: fileStat.mtimeMs,
        content,
      });
      return { path: candidate, content };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function resolveWorkspaceWriteTarget(relativePath: string): {
  safePath: string;
  fullPath: string;
} {
  const candidates = getAliasCandidatesForPath(relativePath);
  const existingCandidate = candidates.find((candidate) =>
    existsSync(join(WORKSPACE_DIR, candidate))
  );
  const safePath = existingCandidate ?? candidates[0];
  const fullPath = join(WORKSPACE_DIR, safePath);

  return { safePath, fullPath };
}

function getWorkspaceDocumentDefinition(
  key: WorkspaceDocumentKey
): WorkspaceDocumentDefinition {
  const definition = WORKSPACE_DOCUMENT_DEFINITIONS.find(
    (candidate) => candidate.key === key
  );
  if (!definition) {
    throw new Error(`Missing workspace document definition for ${key}`);
  }
  return definition;
}

function isAllowedWorkspacePath(relativePath: string): boolean {
  const safePath = sanitizeRelativePath(relativePath);
  const documentKey = getDocumentKeyForPath(safePath);

  if (documentKey && WRITABLE_WORKSPACE_DOCUMENT_KEYS.has(documentKey)) {
    return true;
  }

  const lowered = safePath.toLowerCase();
  return lowered.startsWith("memory/") || lowered.startsWith("skills/");
}

function shouldSyncGeneratedWorkspaceDocument(key: WorkspaceDocumentKey): boolean {
  const definition = getWorkspaceDocumentDefinition(key);
  if (definition.authority !== "generated_mirror") {
    return false;
  }

  const lastSync = generatedWorkspaceSyncTimes.get(key) || 0;
  return Date.now() - lastSync >= GENERATED_WORKSPACE_SYNC_INTERVAL_MS;
}

function markGeneratedWorkspaceSynced(key: WorkspaceDocumentKey): void {
  generatedWorkspaceSyncTimes.set(key, Date.now());
}

async function renderGeneratedToolsDocument(): Promise<string> {
  const readyTools = TOOL_CATALOG.filter((tool) => tool.status === "ready");
  const plannedTools = TOOL_CATALOG.filter((tool) => tool.status === "planned");
  const renderToolList = (tools: typeof TOOL_CATALOG) =>
    tools
      .map(
        (tool) =>
          `- \`${tool.name}\` (${tool.category}, ${tool.sideEffectLevel}${tool.requiresConfirmation ? ", confirmation" : ""}): ${tool.description}`
      )
      .join("\n");

  return `# TOOLS

Generated mirror of Nicole's real tool registry.
Source of truth: code in /Users/apple/nicole/src/lib/ai/tools/catalog.ts and runtime handlers.
Do not treat this file as permission to call a tool that is not actually executable.

## Ready Tools (${readyTools.length})
${renderToolList(readyTools)}

## Planned Tools (${plannedTools.length})
${renderToolList(plannedTools)}
`;
}

async function renderGeneratedMemoryDocument(): Promise<string> {
  const [topMemories, recentSummaries] = await Promise.all([
    db
      .select({
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        topic: memories.topic,
        source: memories.source,
      })
      .from(memories)
      .orderBy(desc(memories.importance), desc(memories.lastReferencedAt), desc(memories.createdAt))
      .limit(16),
    db
      .select({
        summary: conversationSummaries.summary,
        endCreatedAt: conversationSummaries.endCreatedAt,
        messageCount: conversationSummaries.messageCount,
      })
      .from(conversationSummaries)
      .orderBy(desc(conversationSummaries.endCreatedAt), desc(conversationSummaries.createdAt))
      .limit(4),
  ]);

  const memoryLines =
    topMemories.length > 0
      ? topMemories
          .map((memory) => {
            const topic = memory.topic ? ` (re: ${memory.topic})` : "";
            const source = memory.source ? ` [${memory.source}]` : "";
            return `- [${memory.category}]${topic}${source} ${memory.content}`;
          })
          .join("\n")
      : "- No durable memories captured yet.";

  const summaryLines =
    recentSummaries.length > 0
      ? recentSummaries
          .map((entry) => {
            const date = entry.endCreatedAt
              ? new Date(entry.endCreatedAt).toISOString().slice(0, 10)
              : "unknown date";
            const count = entry.messageCount ? ` (${entry.messageCount} messages)` : "";
            return `- ${date}${count}: ${entry.summary}`;
          })
          .join("\n")
      : "- No conversation summaries yet.";

  return `# MEMORY

Generated mirror of Nicole's durable memory.
Source of truth: PostgreSQL memories + conversation summaries.
This file is a compact workspace-facing summary, not the canonical memory database.

## Durable Memory
${memoryLines}

## Recent Conversation Summaries
${summaryLines}
`;
}

async function syncGeneratedWorkspaceDocument(key: WorkspaceDocumentKey): Promise<void> {
  if (!shouldSyncGeneratedWorkspaceDocument(key)) {
    return;
  }

  const definition = getWorkspaceDocumentDefinition(key);
  if (definition.authority !== "generated_mirror") {
    return;
  }

  let content = "";
  if (key === "tools") {
    content = await renderGeneratedToolsDocument();
  } else if (key === "memory") {
    content = await renderGeneratedMemoryDocument();
  } else {
    return;
  }

  const targetPath = definition.aliases[0];
  const fullPath = join(WORKSPACE_DIR, targetPath);

  if (!existsSync(dirname(fullPath))) {
    await mkdir(dirname(fullPath), { recursive: true });
  }

  await writeFile(fullPath, content, "utf-8");
  cachedDocuments.delete(fullPath);
  markGeneratedWorkspaceSynced(key);
}

export async function syncGeneratedWorkspaceFiles(
  keys: WorkspaceDocumentKey[] = ["tools", "memory"]
): Promise<void> {
  for (const key of keys) {
    await syncGeneratedWorkspaceDocument(key);
  }
}

export function getWorkspaceDocumentDefinitions(): WorkspaceDocumentDefinition[] {
  return WORKSPACE_DOCUMENT_DEFINITIONS.map((definition) => ({
    ...definition,
    aliases: [...definition.aliases],
  }));
}

export function buildWorkspaceAuthorityBlock(): string {
  return `## Workspace contract
- SOUL.md, AGENTS.md, IDENTITY.md, USER.md, BOOT.md, BOOTSTRAP.md, and HEARTBEAT.md are machine-level control files.
- TOOLS.md and MEMORY.md are generated mirrors. They summarize the real runtime tool registry and durable memory, but code and database state remain canonical.
- CONTEXT.md and memory/YYYY-MM-DD.md are live runtime notes.
- Skills live in ~/.nicole/skills/<skill>/SKILL.md and extend Nicole's awareness.
- Do not confuse generated mirrors or retrieved source material with your identity.
- Never simulate tool calls, browser actions, inbox scans, calendar reads, or other external results. If a real tool result is not present, say you have not checked yet.`;
}

export async function loadWorkspaceDocument(
  key: WorkspaceDocumentKey,
  options?: { stripTitle?: boolean }
): Promise<WorkspaceDocument | null> {
  await syncGeneratedWorkspaceDocument(key);

  const resolved = await readCachedWorkspacePath([
    ...WORKSPACE_FILE_ALIASES[key],
  ]);

  if (!resolved) {
    return null;
  }

  return {
    key,
    path: resolved.path,
    content:
      options?.stripTitle === false
        ? resolved.content.trim()
        : stripMarkdownTitle(resolved.content),
  };
}

/**
 * Load Nicole's soul prompt from ~/.nicole/SOUL.md (or soul.md).
 * Falls back to the hardcoded prompt if the file doesn't exist.
 * Caches the result and reloads only when the file changes.
 */
export async function loadSoulPrompt(): Promise<string> {
  const doc = await loadWorkspaceDocument("soul");

  if (!doc) {
    const { NICOLE_SYSTEM_PROMPT } = await import("./personality");
    return NICOLE_SYSTEM_PROMPT;
  }

  const prompt = doc.content
    .replace(/^You are Nicole\.\s*\n*/m, "You are Nicole.\n\n")
    .trim();

  return prompt.startsWith("You are Nicole")
    ? prompt
    : `You are Nicole.\n\n${prompt}`;
}

/**
 * Load the workspace daily note for today, if present.
 */
export async function loadTodayDailyMemory(): Promise<WorkspacePromptLayer | null> {
  const date = todayString();
  const doc = await readWorkspaceFile(`memory/${date}.md`);

  if (!doc?.trim()) {
    return null;
  }

  return {
    key: "dailyMemory",
    title: "Today's workspace notes",
    content: `Current day note from Nicole's machine-level workspace.\n\n${stripMarkdownTitle(doc)}`,
  };
}

/**
 * Load the OpenClaw-style workspace prompt layers that should shape Nicole.
 */
export async function loadWorkspacePromptLayers(): Promise<
  WorkspacePromptLayer[]
> {
  await syncGeneratedWorkspaceFiles();

  const layers: WorkspacePromptLayer[] = [];

  for (const spec of WORKSPACE_PROMPT_LAYER_SPECS) {
    const doc = await loadWorkspaceDocument(spec.key);
    if (!doc?.content) {
      continue;
    }

    layers.push({
      key: spec.key,
      title: spec.title,
      content: spec.note ? `${spec.note}\n\n${doc.content}` : doc.content,
    });
  }

  const todayLayer = await loadTodayDailyMemory();
  if (todayLayer) {
    layers.push(todayLayer);
  }

  return layers;
}

/**
 * Discover skills from ~/.nicole/skills/<name>/SKILL.md.
 * Returns an array of skill definitions Nicole can reference.
 */
export async function discoverSkills(): Promise<SkillDefinition[]> {
  try {
    if (!existsSync(SKILLS_DIR)) return [];

    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: SkillDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
      try {
        const content = await readFile(skillPath, "utf-8");
        skills.push({ name: entry.name, content: content.trim() });
      } catch {
        // Skill directory exists but no SKILL.md — skip
      }
    }

    return skills;
  } catch {
    return [];
  }
}

/**
 * Build a compact skill awareness block for the system prompt.
 */
export async function buildSkillAwarenessBlock(): Promise<string | null> {
  const skills = await discoverSkills();
  if (skills.length === 0) return null;

  const summaries = skills.map((s) => {
    const lines = s.content.split("\n").filter((line) => line.trim());
    const title = lines[0]?.replace(/^#+\s*/, "") || s.name;
    const desc = lines[1] || "";
    return `- **${title}**: ${desc}`;
  });

  return `## Nicole's Skills\n${summaries.join("\n")}`;
}

/**
 * Read a file from Nicole's workspace.
 */
export async function readWorkspaceFile(
  relativePath: string
): Promise<string | null> {
  const documentKey = getDocumentKeyForPath(relativePath);
  if (documentKey) {
    await syncGeneratedWorkspaceDocument(documentKey);
  }

  const resolved = await readCachedWorkspacePath(
    getAliasCandidatesForPath(relativePath)
  );

  return resolved?.content ?? null;
}

/**
 * Write a file to Nicole's workspace (only to allowed paths).
 */
export async function writeWorkspaceFile(
  relativePath: string,
  content: string
): Promise<{ ok: boolean; path: string; error?: string }> {
  const normalized = sanitizeRelativePath(relativePath);

  if (!isAllowedWorkspacePath(normalized)) {
    return {
      ok: false,
      path: normalized,
      error:
        "Nicole can only write to: USER.md, CONTEXT.md, memory/, and skills/. SOUL.md, AGENTS.md, IDENTITY.md, TOOLS.md, MEMORY.md, and config files are managed by Roy or generated by the system.",
    };
  }

  const { safePath, fullPath } = resolveWorkspaceWriteTarget(normalized);
  if (!fullPath.startsWith(WORKSPACE_DIR)) {
    return { ok: false, path: safePath, error: "Path escapes workspace." };
  }

  try {
    if (!existsSync(dirname(fullPath))) {
      await mkdir(dirname(fullPath), { recursive: true });
    }

    await writeFile(fullPath, content, "utf-8");
    cachedDocuments.delete(fullPath);
    return { ok: true, path: safePath };
  } catch (error) {
    return {
      ok: false,
      path: safePath,
      error: `Write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * List files in a workspace subdirectory.
 */
export async function listWorkspaceFiles(subdir = ""): Promise<string[]> {
  const safePath = sanitizeRelativePath(subdir);
  const fullPath = join(WORKSPACE_DIR, safePath);

  if (!fullPath.startsWith(WORKSPACE_DIR)) return [];

  try {
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
}

/**
 * Get today's date string in YYYY-MM-DD format.
 */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append to today's daily memory file.
 */
export async function appendToDailyMemory(entry: string): Promise<void> {
  const date = todayString();
  const filePath = join(MEMORY_DIR, `${date}.md`);

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    existing = `# ${date}\n\n## Notes\n`;
  }

  const updated = `${existing.trimEnd()}\n- ${entry}\n`;
  await writeFile(filePath, updated, "utf-8");
  cachedDocuments.delete(filePath);
}

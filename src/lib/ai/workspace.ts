import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const WORKSPACE_DIR = join(homedir(), ".nicole");
const SOUL_PATH = join(WORKSPACE_DIR, "soul.md");
const USER_PATH = join(WORKSPACE_DIR, "user.md");
const IDENTITY_PATH = join(WORKSPACE_DIR, "identity.md");
const CONTEXT_PATH = join(WORKSPACE_DIR, "context.md");
const SKILLS_DIR = join(WORKSPACE_DIR, "skills");
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");

// --- Soul prompt (personality) ---

let cachedSoulPrompt: string | null = null;
let soulMtime: number = 0;

/**
 * Load Nicole's soul prompt from ~/.nicole/soul.md.
 * Falls back to the hardcoded prompt if the file doesn't exist.
 * Caches the result and reloads only when the file changes.
 */
export async function loadSoulPrompt(): Promise<string> {
  try {
    const stat = await import("node:fs/promises").then((fs) =>
      fs.stat(SOUL_PATH)
    );
    const mtime = stat.mtimeMs;

    if (cachedSoulPrompt && mtime === soulMtime) {
      return cachedSoulPrompt;
    }

    const raw = await readFile(SOUL_PATH, "utf-8");
    // Strip the markdown title line if present
    const prompt = raw
      .replace(/^#\s+Nicole\s*—\s*Soul\s*\n*/i, "")
      .replace(/^You are Nicole\.\s*\n*/m, "You are Nicole.\n\n")
      .trim();

    cachedSoulPrompt = prompt.startsWith("You are Nicole")
      ? prompt
      : `You are Nicole.\n\n${prompt}`;
    soulMtime = mtime;
    return cachedSoulPrompt;
  } catch {
    // File doesn't exist — fall back to hardcoded personality
    const { NICOLE_SYSTEM_PROMPT } = await import("./personality");
    return NICOLE_SYSTEM_PROMPT;
  }
}

// --- Skill discovery ---

export interface SkillDefinition {
  name: string;
  content: string;
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
    // Extract just the first line (title) and first paragraph
    const lines = s.content.split("\n").filter((l) => l.trim());
    const title = lines[0]?.replace(/^#+\s*/, "") || s.name;
    const desc = lines[1] || "";
    return `- **${title}**: ${desc}`;
  });

  return `## Nicole's Skills\n${summaries.join("\n")}`;
}

// --- Workspace file read/write ---

const ALLOWED_WORKSPACE_PATHS = [
  "context.md",
  "user.md",
  "memory/",
  "skills/",
];

function isAllowedWorkspacePath(relativePath: string): boolean {
  // soul.md and identity.md are readable but not writable by Nicole
  // config.md and tools.md are managed externally
  return ALLOWED_WORKSPACE_PATHS.some((prefix) =>
    relativePath.startsWith(prefix)
  );
}

/**
 * Read a file from Nicole's workspace.
 */
export async function readWorkspaceFile(
  relativePath: string
): Promise<string | null> {
  const safePath = relativePath.replace(/\.\./g, "");
  const fullPath = join(WORKSPACE_DIR, safePath);

  if (!fullPath.startsWith(WORKSPACE_DIR)) return null;

  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a file to Nicole's workspace (only to allowed paths).
 */
export async function writeWorkspaceFile(
  relativePath: string,
  content: string
): Promise<{ ok: boolean; path: string; error?: string }> {
  const safePath = relativePath.replace(/\.\./g, "");

  if (!isAllowedWorkspacePath(safePath)) {
    return {
      ok: false,
      path: safePath,
      error: `Nicole can only write to: ${ALLOWED_WORKSPACE_PATHS.join(", ")}. soul.md, identity.md, config.md, and tools.md are managed by Roy.`,
    };
  }

  const fullPath = join(WORKSPACE_DIR, safePath);
  if (!fullPath.startsWith(WORKSPACE_DIR)) {
    return { ok: false, path: safePath, error: "Path escapes workspace." };
  }

  try {
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content, "utf-8");
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
export async function listWorkspaceFiles(
  subdir: string = ""
): Promise<string[]> {
  const safePath = subdir.replace(/\.\./g, "");
  const fullPath = join(WORKSPACE_DIR, safePath);

  if (!fullPath.startsWith(WORKSPACE_DIR)) return [];

  try {
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries.map((e) =>
      e.isDirectory() ? `${e.name}/` : e.name
    );
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
}

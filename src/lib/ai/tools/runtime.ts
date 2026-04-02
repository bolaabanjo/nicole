import { desc, eq, count } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { searchRelevantMemories, storeMemory } from "@/lib/ai/memory";
import { ChatMessage } from "@/lib/ai/types";
import { db } from "@/lib/db/client";
import {
  chunks,
  notes,
  sources,
  toolInvocations,
} from "@/lib/db/schema";
import { deepResearch } from "@/lib/search/research";
import { searchRelevantSourceChunks } from "@/lib/search/semantic";
import { searchWeb } from "@/lib/search/web";
import {
  READY_TOOL_NAMES,
  TOOL_CATALOG,
  ToolDefinition,
} from "./catalog";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionResult {
  ok: boolean;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

interface ToolHandlerContext {
  tool: ToolDefinition;
}

type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolHandlerContext
) => Promise<unknown>;

interface RunToolLoopOptions {
  systemPrompt: string;
  recentMessages: ChatMessage[];
  userMessage: string;
  maxSteps?: number;
}

interface RunToolLoopResult {
  toolResults: ToolExecutionResult[];
  usedTools: string[];
}

const MAX_TOOL_STEPS = 3;
const CASUAL_TOOL_BYPASS_PATTERNS = [
  /^hi[.!?]*$/i,
  /^hey[.!?]*$/i,
  /^hello[.!?]*$/i,
  /^yo[.!?]*$/i,
  /^sup[.!?]*$/i,
  /^what'?s up[.!?]*$/i,
  /^how are you[.!?]*$/i,
];

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  tool_registry_list: async () => ({
    ready: getReadyTools().map(minifyToolDefinition),
    planned: TOOL_CATALOG.filter((tool) => tool.status === "planned").map(
      minifyToolDefinition
    ),
  }),
  memory_search: async (input) => {
    const query = readRequiredString(input, "query");
    const limit = readOptionalNumber(input, "limit", 6, 1, 12);
    const results = await searchRelevantMemories(query, limit);
    return { results };
  },
  memory_store: async (input) => {
    const content = readRequiredString(input, "content");
    const category = readRequiredString(input, "category");
    const importance = readOptionalNumber(input, "importance", 5, 1, 10);
    const topic = readOptionalString(input, "topic");

    await storeMemory({
      content,
      category,
      importance,
      topic: topic || undefined,
      source: "conversation",
    });

    return {
      stored: true,
      memory: { content, category, importance, topic: topic || null },
    };
  },
  source_search: async (input) => {
    const query = readRequiredString(input, "query");
    const limit = readOptionalNumber(input, "limit", 6, 1, 12);
    const results = await searchRelevantSourceChunks(query, limit);
    return { results };
  },
  source_list: async (input) => {
    const limit = readOptionalNumber(input, "limit", 20, 1, 50);

    const allSources = await db
      .select({
        id: sources.id,
        title: sources.title,
        type: sources.type,
        url: sources.url,
        ingestedAt: sources.ingestedAt,
        chunkCount: count(chunks.id),
      })
      .from(sources)
      .leftJoin(chunks, eq(sources.id, chunks.sourceId))
      .groupBy(sources.id)
      .orderBy(desc(sources.ingestedAt))
      .limit(limit);

    return { sources: allSources };
  },
  source_get: async (input) => {
    const sourceId = readRequiredString(input, "sourceId");

    const sourceRows = await db
      .select({
        id: sources.id,
        title: sources.title,
        type: sources.type,
        url: sources.url,
        filePath: sources.filePath,
        summary: sources.summary,
        rawText: sources.rawText,
        ingestedAt: sources.ingestedAt,
      })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);

    if (sourceRows.length === 0) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    return { source: sourceRows[0] };
  },
  web_search: async (input) => {
    const query = readRequiredString(input, "query");
    const limit = readOptionalNumber(input, "limit", 5, 1, 10);
    const results = await searchWeb(query, limit);
    return { results };
  },
  deep_research: async (input) => {
    const query = readRequiredString(input, "query");
    const result = await deepResearch(query);
    return result;
  },
  note_create: async (input) => {
    const content = readRequiredString(input, "content");
    const title = readOptionalString(input, "title");
    const type = readOptionalString(input, "type") || "note";

    const created = await db
      .insert(notes)
      .values({
        title: title || null,
        content,
        type,
      })
      .returning({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        type: notes.type,
        createdAt: notes.createdAt,
      });

    return { note: created[0] };
  },
  note_update: async (input) => {
    const id = readRequiredString(input, "id");
    const title = readOptionalString(input, "title");
    const content = readOptionalString(input, "content");
    const type = readOptionalString(input, "type");

    const updated = await db
      .update(notes)
      .set({
        title: title ?? undefined,
        content: content ?? undefined,
        type: type ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .returning({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        type: notes.type,
        updatedAt: notes.updatedAt,
      });

    if (updated.length === 0) {
      throw new Error(`Note not found: ${id}`);
    }

    return { note: updated[0] };
  },
};

export function getToolCatalog(): ToolDefinition[] {
  return TOOL_CATALOG;
}

export function getReadyTools(): ToolDefinition[] {
  return TOOL_CATALOG.filter(
    (tool) => tool.status === "ready" && tool.name in TOOL_HANDLERS
  );
}

export function buildToolDecisionPrompt(): string {
  const manifest = getReadyTools()
    .map((tool) =>
      [
        `- ${tool.name}`,
        `  description: ${tool.description}`,
        `  when: ${tool.whenToUse}`,
        `  side_effect: ${tool.sideEffectLevel}`,
        `  confirmation_required: ${tool.requiresConfirmation ? "yes" : "no"}`,
        `  input: ${JSON.stringify(tool.inputSchema)}`,
      ].join("\n")
    )
    .join("\n");

  return `## Tool use
You may use Nicole's tools if they would materially improve the answer.

If you need a tool, respond with ONLY one XML block in exactly this format:
<tool_call>{"name":"tool_name","arguments":{}}</tool_call>

Rules:
- Call at most one tool per response
- Use only the tools listed below
- If no tool is needed, respond with NO_TOOL
- Never include explanation, markdown, or extra text when making a tool decision

Available tools:
${manifest}`;
}

export function shouldAttemptToolUse(message: string): boolean {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (CASUAL_TOOL_BYPASS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return /\b(search|look up|lookup|latest|current|research|find out|web|source|sources|library|pdf|document|notes?|remember|save this|store this|list tools|what can you do|create note|update note)\b/.test(
    normalized
  );
}

export async function runToolPlanningLoop(
  options: RunToolLoopOptions
): Promise<RunToolLoopResult> {
  const toolResults: ToolExecutionResult[] = [];
  const toolMessages: ChatMessage[] = [];

  if (getReadyTools().length === 0) {
    return { toolResults, usedTools: [] };
  }

  for (let step = 0; step < (options.maxSteps ?? MAX_TOOL_STEPS); step += 1) {
    const decisionMessages: ChatMessage[] = [
      {
        role: "system",
        content: `${options.systemPrompt}\n\n${buildToolDecisionPrompt()}`,
      },
      ...options.recentMessages,
      ...toolMessages,
      { role: "user", content: options.userMessage },
    ];

    const decision = await chat(decisionMessages, {
      temperature: 0,
      maxTokens: 400,
    });
    const decisionText =
      typeof decision === "string" ? decision.trim() : String(decision).trim();
    const toolCall = parseToolCall(decisionText);

    if (!toolCall) {
      break;
    }

    const result = await executeToolCall(toolCall);
    toolResults.push(result);

    toolMessages.push({ role: "assistant", content: decisionText });
    toolMessages.push({
      role: "system",
      content: formatToolResultForPlanning(result),
    });
  }

  return {
    toolResults,
    usedTools: Array.from(new Set(toolResults.map((result) => result.name))),
  };
}

export function formatToolResultsForPrompt(
  toolResults: ToolExecutionResult[]
): string {
  if (toolResults.length === 0) {
    return "";
  }

  return toolResults
    .map((result) => {
      if (!result.ok) {
        return `Tool ${result.name} failed.\nError: ${result.error}`;
      }

      return `Tool ${result.name} returned:\n${JSON.stringify(
        result.output,
        null,
        2
      )}`;
    })
    .join("\n\n");
}

export function parseToolCall(content: string): ToolCall | null {
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as Partial<ToolCall>;
    if (
      typeof parsed.name === "string" &&
      parsed.name.length > 0 &&
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        name: parsed.name,
        arguments: parsed.arguments as Record<string, unknown>,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function executeToolCall(
  toolCall: ToolCall
): Promise<ToolExecutionResult> {
  const tool = TOOL_CATALOG.find((entry) => entry.name === toolCall.name);

  if (!tool) {
    return {
      ok: false,
      name: toolCall.name,
      input: toolCall.arguments,
      error: `Unknown tool: ${toolCall.name}`,
    };
  }

  const handler = TOOL_HANDLERS[tool.name];
  if (!handler || tool.status !== "ready") {
    const result = {
      ok: false,
      name: tool.name,
      input: toolCall.arguments,
      error: `Tool not available yet: ${tool.name}`,
    } satisfies ToolExecutionResult;

    await logToolInvocation(tool, result);
    return result;
  }

  try {
    validateToolInput(tool, toolCall.arguments);
    const output = await handler(toolCall.arguments, { tool });
    const result = {
      ok: true,
      name: tool.name,
      input: toolCall.arguments,
      output,
    } satisfies ToolExecutionResult;

    await logToolInvocation(tool, result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      name: tool.name,
      input: toolCall.arguments,
      error: error instanceof Error ? error.message : "Tool execution failed",
    } satisfies ToolExecutionResult;

    await logToolInvocation(tool, result);
    return result;
  }
}

function formatToolResultForPlanning(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `TOOL RESULT (${result.name})\n${JSON.stringify(
      {
        ok: false,
        error: result.error,
      },
      null,
      2
    )}`;
  }

  return `TOOL RESULT (${result.name})\n${JSON.stringify(
    {
      ok: true,
      output: result.output,
    },
    null,
    2
  )}`;
}

async function logToolInvocation(
  tool: ToolDefinition,
  result: ToolExecutionResult
): Promise<void> {
  try {
    await db.insert(toolInvocations).values({
      toolName: tool.name,
      status: result.ok ? "success" : "error",
      sideEffectLevel: tool.sideEffectLevel,
      requiresConfirmation: tool.requiresConfirmation ? "true" : "false",
      input: result.input,
      output: result.ok ? safeJson(result.output) : null,
      error: result.ok ? null : result.error || null,
    });
  } catch (error) {
    console.error("Failed to log tool invocation:", error);
  }
}

function validateToolInput(
  tool: ToolDefinition,
  input: Record<string, unknown>
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid input for ${tool.name}`);
  }

  for (const key of tool.inputSchema.required || []) {
    if (!(key in input)) {
      throw new Error(`Missing required field "${key}" for ${tool.name}`);
    }
  }
}

function minifyToolDefinition(tool: ToolDefinition) {
  return {
    name: tool.name,
    category: tool.category,
    title: tool.title,
    description: tool.description,
    whenToUse: tool.whenToUse,
    status: tool.status,
    sideEffectLevel: tool.sideEffectLevel,
    requiresConfirmation: tool.requiresConfirmation,
  };
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected "${key}" to be a non-empty string`);
  }

  return value.trim();
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string
): string | null {
  const value = input[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalNumber(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = input[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(value), min), max);
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

export const ENABLED_TOOL_NAMES = READY_TOOL_NAMES.filter(
  (toolName) => toolName in TOOL_HANDLERS
);

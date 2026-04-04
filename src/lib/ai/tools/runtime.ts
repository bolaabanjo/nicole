import { spawn } from "node:child_process";
import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { searchRelevantMemories, storeMemory } from "@/lib/ai/memory";
import { ChatMessage } from "@/lib/ai/types";
import { db } from "@/lib/db/client";
import {
  calendarEvents,
  chunks,
  notes,
  reminders,
  sources,
  toolInvocations,
} from "@/lib/db/schema";
import {
  createGoogleCalendarEvent,
  listGoogleCalendarEvents,
} from "@/lib/integrations/google-calendar";
import { searchZohoMail, sendZohoMail } from "@/lib/integrations/zoho-mail";
import { deepResearch } from "@/lib/search/research";
import { searchRelevantSourceChunks } from "@/lib/search/semantic";
import { searchWeb, fetchPageContent } from "@/lib/search/web";
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
const TOOL_PLANNING_ENABLED = resolveToolPlanningEnabled();
const TOOL_REPO_ROOT = process.cwd();
const CASUAL_TOOL_BYPASS_PATTERNS = [
  /^hi[.!?]*$/i,
  /^hey[.!?]*$/i,
  /^hello[.!?]*$/i,
  /^yo[.!?]*$/i,
  /^sup[.!?]*$/i,
  /^what'?s up[.!?]*$/i,
  /^how are you[.!?]*$/i,
];
const DIRECT_TOOL_COMMAND_PATTERNS = [
  /\bremind me to\b/i,
  /\bset a reminder\b/i,
  /\bcreate a reminder\b/i,
  /\bwhat'?s on my calendar\b/i,
  /\bcheck my calendar\b/i,
  /\bmy schedule\b/i,
  /\bfree time\b/i,
  /\bavailability\b/i,
  /\bschedule\b/i,
  /\bcreate (?:an )?event\b/i,
  /\badd .* to (?:my )?calendar\b/i,
  /\bgit status\b/i,
  /\brepo status\b/i,
  /\bwhat changed in (?:the )?repo\b/i,
  /\bsearch (?:my )?email\b/i,
  /\bfind (?:an |the )?email\b/i,
  /\bsend (?:an )?email\b/i,
  /\brun [`'"]/i,
  /\bexecute [`'"]/i,
];
const BLOCKED_COMMAND_PATTERN = /[;&|><`$()]/;
const ALLOWED_TERMINAL_PREFIXES = [
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["rg"],
  ["ls"],
  ["dir"],
  ["pwd"],
  ["Get-Location"],
  ["cat"],
  ["type"],
  ["sed"],
  ["npm", "run", "build"],
  ["npm", "run", "lint"],
  ["npm", "test"],
];
const TERMINAL_TIMEOUT_MS = 15_000;
const MAX_TERMINAL_OUTPUT_CHARS = 12_000;

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
        scope: sources.scope,
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
        scope: sources.scope,
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
    const response = await searchWeb(query, limit);
    if (response.error) {
      throw new Error(response.error);
    }
    return { results: response.results, provider: response.provider };
  },
  web_open: async (input) => {
    const url = readRequiredString(input, "url");
    const page = await fetchPageContent(url);
    if (!page.text) {
      throw new Error(`Could not extract content from: ${url}`);
    }
    return { title: page.title, url: page.url, text: page.text, wordCount: page.wordCount };
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
  calendar_read: async (input) => {
    const start = coerceDateTime(readOptionalString(input, "start")) ?? new Date();
    const end =
      coerceDateTime(readOptionalString(input, "end")) ??
      new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const limit = readOptionalNumber(input, "limit", 12, 1, 30);

    const googleEvents = await listGoogleCalendarEvents({
      start: start.toISOString(),
      end: end.toISOString(),
      limit,
    });

    if (googleEvents) {
      return {
        provider: "google_calendar",
        window: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        events: googleEvents,
        availability: summarizeAvailability(
          start,
          end,
          googleEvents.map((event) => ({
            title: event.title,
            startAt: new Date(event.startAt),
            endAt: new Date(event.endAt),
          }))
        ),
      };
    }

    const events = await db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        description: calendarEvents.description,
        location: calendarEvents.location,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        source: calendarEvents.source,
      })
      .from(calendarEvents)
      .where(
        and(gte(calendarEvents.startAt, start), lte(calendarEvents.startAt, end))
      )
      .orderBy(asc(calendarEvents.startAt))
      .limit(limit);

    return {
      provider: "nicole_local",
      window: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      events,
      availability: summarizeAvailability(start, end, events),
    };
  },
  calendar_create_event: async (input) => {
    const title = readRequiredString(input, "title");
    const start = coerceDateTime(readRequiredString(input, "start"));
    const end = coerceDateTime(readRequiredString(input, "end"));
    const description = readOptionalString(input, "description");
    const location = readOptionalString(input, "location");

    if (!start || !end) {
      throw new Error("Event start and end must be valid date-time values.");
    }

    if (end <= start) {
      throw new Error("Event end must be after the start time.");
    }

    const googleEvent = await createGoogleCalendarEvent({
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      description,
      location,
    });

    if (googleEvent) {
      return {
        provider: "google_calendar",
        event: googleEvent,
        conflicts: [],
      };
    }

    const conflicts = await db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
      })
      .from(calendarEvents)
      .where(
        and(lte(calendarEvents.startAt, end), gte(calendarEvents.endAt, start))
      )
      .orderBy(asc(calendarEvents.startAt))
      .limit(10);

    const created = await db
      .insert(calendarEvents)
      .values({
        title,
        description: description || null,
        location: location || null,
        startAt: start,
        endAt: end,
        source: "nicole",
        updatedAt: new Date(),
      })
      .returning({
        id: calendarEvents.id,
        title: calendarEvents.title,
        description: calendarEvents.description,
        location: calendarEvents.location,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        source: calendarEvents.source,
        createdAt: calendarEvents.createdAt,
      });

    return {
      provider: "nicole_local",
      event: created[0],
      conflicts,
    };
  },
  reminder_create: async (input) => {
    const title = readRequiredString(input, "title");
    const dueAtRaw = readOptionalString(input, "dueAt");
    const notesText = readOptionalString(input, "notes");
    const dueAt = dueAtRaw ? coerceDateTime(dueAtRaw) : null;

    if (dueAtRaw && !dueAt) {
      throw new Error(
        `Reminder due time could not be parsed: ${dueAtRaw}. Use a clearer time like "tomorrow at 5pm" or an ISO timestamp.`
      );
    }

    const created = await db
      .insert(reminders)
      .values({
        title,
        notes: notesText || null,
        dueAt: dueAt || null,
        status: "pending",
        updatedAt: new Date(),
      })
      .returning({
        id: reminders.id,
        title: reminders.title,
        notes: reminders.notes,
        dueAt: reminders.dueAt,
        status: reminders.status,
        createdAt: reminders.createdAt,
      });

    return { reminder: created[0] };
  },
  email_search: async (input) => {
    const query = readRequiredString(input, "query");
    const limit = readOptionalNumber(input, "limit", 8, 1, 20);
    const results = await searchZohoMail({ query, limit });

    if (results) {
      return {
        provider: "zoho_mail",
        results,
      };
    }

    throw new Error(
      "Zoho Mail is not connected yet. Connect it from Integrations first."
    );
  },
  email_send: async (input) => {
    const to = readRequiredString(input, "to");
    const subject = readRequiredString(input, "subject");
    const body = readRequiredString(input, "body");
    const cc = readOptionalString(input, "cc");
    const result = await sendZohoMail({ to, subject, body, cc });

    if (result) {
      return result;
    }

    throw new Error(
      "Zoho Mail is not connected yet. Connect it from Integrations first."
    );
  },
  terminal_run: async (input) => {
    const command = readRequiredString(input, "command");
    const result = await runControlledTerminalCommand(command);
    return result;
  },
  git_status: async () => {
    const status = await runControlledTerminalCommand("git status --short --branch");
    const diff = await runControlledTerminalCommand("git diff --stat");
    return {
      status,
      diff,
    };
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
You are deciding whether Nicole needs a tool to answer this message well.

If you need a tool, respond with ONLY one XML block in exactly this format:
<tool_call>{"name":"tool_name","arguments":{}}</tool_call>

If no tool is needed, respond with exactly: NO_TOOL

When to use web_search:
- Questions about current events, news, recent happenings, or anything after your knowledge cutoff
- Questions about specific people, companies, or projects where up-to-date facts matter
- Anything where being wrong would be worse than taking a second to check
- When the user explicitly asks you to look something up
- When you are not confident in the answer and a search would resolve it

When to use web_open:
- After a web_search, when the search snippets are not enough and you need the full page content

When NOT to use tools:
- Casual conversation, greetings, emotional support, opinions, advice
- Questions you can answer confidently from general knowledge (math, definitions, well-known facts)
- Follow-up messages in an ongoing conversation where context is already available

Rules:
- Call at most one tool per response
- Use only the tools listed below
- Never include explanation, markdown, or extra text — only the tool call or NO_TOOL
- Prefer web_search over guessing when the answer depends on facts you might get wrong

Available tools:
${manifest}`;
}

export async function runDirectToolRouting(
  message: string,
  recentMessages: ChatMessage[] = []
): Promise<ToolExecutionResult[]> {
  const directToolCall = detectDirectToolCall(message, recentMessages);

  if (!directToolCall) {
    return [];
  }

  return [await executeToolCall(directToolCall)];
}

/**
 * Messages that are clearly casual / emotional and should never trigger tools.
 * Keep this tight — when in doubt, let the LLM planner decide.
 */
const TOOL_BYPASS_PATTERNS = [
  ...CASUAL_TOOL_BYPASS_PATTERNS,
  /^(thanks|thank you|thx|ty|ok|okay|k|cool|nice|lol|haha|hmm|yeah|nah|nope|yep|bet|got it|alright)[.!?]*$/i,
  /^(good morning|good night|gn|gm|morning)[.!?]*$/i,
  /^(i love you|i hate you|i miss you|fuck|shit|damn)[.!?]*$/i,
];

export function shouldAttemptToolUse(message: string): boolean {
  if (!TOOL_PLANNING_ENABLED) {
    return false;
  }

  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  // Short casual messages — skip tools entirely
  if (TOOL_BYPASS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  // Direct command patterns — always use tools
  if (DIRECT_TOOL_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Explicit tool keywords — always use tools
  if (
    /\b(search|look up|lookup|research|find out|web|source|sources|library|pdf|document|notes?|remember|save this|store this|list tools|what can you do|create note|update note)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  // Questions that likely need current/external information — let the planner decide
  if (
    /\b(latest|current|recent|today|yesterday|this week|this month|right now|news|update|happening|weather|price|stock|score|result|release|announce|launch)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  // Questions starting with who/what/when/where/how/why/is/are/did/does/has/have + enough length
  // Short ones like "what?" or "who cares" get filtered, but real questions go to the planner
  if (
    normalized.length > 15 &&
    /^(who|what|when|where|how|why|is|are|did|does|has|have|can|could|will|should)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  // If the message is a question (ends with ?) and is substantive, let the planner decide
  if (normalized.endsWith("?") && normalized.length > 20) {
    return true;
  }

  return false;
}

export async function runToolPlanningLoop(
  options: RunToolLoopOptions
): Promise<RunToolLoopResult> {
  const toolResults: ToolExecutionResult[] = [];
  const toolMessages: ChatMessage[] = [];

  if (!TOOL_PLANNING_ENABLED || getReadyTools().length === 0) {
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

    let decisionText = "";

    try {
      const decision = await chat(decisionMessages, {
        temperature: 0,
        maxTokens: 400,
      });
      decisionText =
        typeof decision === "string" ? decision.trim() : String(decision).trim();
    } catch (error) {
      console.error("Tool planning failed:", error);
      break;
    }

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

function resolveToolPlanningEnabled(): boolean {
  const configured = process.env.TOOL_PLANNING_ENABLED?.trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return process.env.CHAT_PROVIDER?.trim().toLowerCase() !== "ollama";
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

function detectDirectToolCall(
  message: string,
  recentMessages: ChatMessage[] = []
): ToolCall | null {
  const trimmed = message.trim();

  if (!trimmed) {
    return null;
  }

  return (
    parseWebSearchToolCall(trimmed, recentMessages) ||
    parseDeepResearchToolCall(trimmed, recentMessages) ||
    parseReminderToolCall(trimmed) ||
    parseCalendarCreateToolCall(trimmed) ||
    parseCalendarReadToolCall(trimmed) ||
    parseEmailSearchToolCall(trimmed) ||
    parseEmailSendToolCall(trimmed) ||
    parseGitStatusToolCall(trimmed) ||
    parseTerminalToolCall(trimmed) ||
    parseToolRegistryCall(trimmed)
  );
}

function parseWebSearchToolCall(
  message: string,
  recentMessages: ChatMessage[]
): ToolCall | null {
  const explicitMatch =
    message.match(
      /^(?:search the web|search web|web search|google|look up|lookup)\s+(?:for\s+)?(.+)$/i
    ) ||
    message.match(/^(?:who|what|where|when)\s+is\s+(.+)\??$/i);

  if (explicitMatch) {
    const query = cleanSearchQuery(explicitMatch[1]);
    if (query) {
      return {
        name: "web_search",
        arguments: { query, limit: 5 },
      };
    }
  }

  if (/^(?:google|look (?:him|her|them|it) up|search the web)\s+(?:him|her|them|it)\.?$/i.test(message)) {
    const inferred = inferSearchQueryFromHistory(recentMessages);
    if (inferred) {
      return {
        name: "web_search",
        arguments: { query: inferred, limit: 5 },
      };
    }
  }

  return null;
}

function parseDeepResearchToolCall(
  message: string,
  recentMessages: ChatMessage[]
): ToolCall | null {
  const explicitMatch = message.match(
    /^(?:research|deep research|look into|find out about)\s+(.+)$/i
  );

  if (explicitMatch) {
    const query = cleanSearchQuery(explicitMatch[1]);
    if (query) {
      return {
        name: "deep_research",
        arguments: { query },
      };
    }
  }

  if (/^(?:research|look into)\s+(?:him|her|them|it)\.?$/i.test(message)) {
    const inferred = inferSearchQueryFromHistory(recentMessages);
    if (inferred) {
      return {
        name: "deep_research",
        arguments: { query: inferred },
      };
    }
  }

  return null;
}

function parseToolRegistryCall(message: string): ToolCall | null {
  if (
    /\b(list tools|what tools can you use|what can you do|show tools|tool registry)\b/i.test(
      message
    )
  ) {
    return { name: "tool_registry_list", arguments: {} };
  }

  return null;
}

function parseCalendarReadToolCall(message: string): ToolCall | null {
  if (
    /\bwhat'?s on my calendar\b/i.test(message) ||
    /\bcheck my calendar\b/i.test(message) ||
    /\bshow my calendar\b/i.test(message) ||
    /\bmy schedule\b/i.test(message) ||
    /\bupcoming events\b/i.test(message) ||
    /\bfree time\b/i.test(message) ||
    /\bavailability\b/i.test(message) ||
    /\bam i free\b/i.test(message)
  ) {
    const range = extractCalendarRange(message);
    return {
      name: "calendar_read",
      arguments: range,
    };
  }

  return null;
}

function parseCalendarCreateToolCall(message: string): ToolCall | null {
  const addMatch = message.match(
    /^(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?calendar(?:\s+(.*))?$/i
  );

  if (addMatch) {
    const parsed = buildCalendarEventArguments(
      addMatch[1],
      addMatch[2] || ""
    );
    return parsed
      ? { name: "calendar_create_event", arguments: parsed }
      : null;
  }

  const scheduleMatch = message.match(
    /^(?:schedule|book|create(?:\s+an?)?\s+event(?:\s+called)?)(?:\s+me)?\s+(.+)$/i
  );

  if (scheduleMatch) {
    const parsed = buildCalendarEventArguments(scheduleMatch[1]);
    return parsed
      ? { name: "calendar_create_event", arguments: parsed }
      : null;
  }

  return null;
}

function buildCalendarEventArguments(
  primary: string,
  trailing = ""
): Record<string, unknown> | null {
  const raw = `${primary} ${trailing}`.trim();
  if (!raw) {
    return null;
  }

  const fromToMatch = raw.match(/^(.*?)\s+from\s+(.+?)\s+to\s+(.+)$/i);
  if (fromToMatch) {
    const title = cleanEventTitle(fromToMatch[1]);
    const start = coerceDateTime(fromToMatch[2]);
    const end = coerceDateTime(fromToMatch[3]);

    if (title && start && end) {
      return {
        title,
        start: start.toISOString(),
        end: end.toISOString(),
      };
    }

    return null;
  }

  const split = splitTextAndDatePhrase(raw);
  if (!split?.title || !split.datePhrase) {
    return null;
  }

  const start = coerceDateTime(split.datePhrase);
  if (!start) {
    return null;
  }

  const duration = parseDurationMs(split.durationPhrase) ?? 60 * 60 * 1000;
  const end = new Date(start.getTime() + duration);

  return {
    title: cleanEventTitle(split.title),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function cleanEventTitle(value: string): string {
  return value
    .replace(/\b(?:for|on|at|today|tomorrow|tonight)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReminderToolCall(message: string): ToolCall | null {
  const match = message.match(
    /^(?:remind me to|set a reminder(?: to)?|create a reminder(?: to)?|make a reminder(?: to)?)\s+(.+)$/i
  );

  if (!match) {
    return null;
  }

  const split = splitTextAndDatePhrase(match[1]);
  const title = split?.title || match[1];
  const dueAt = split?.datePhrase ? coerceDateTime(split.datePhrase) : null;

  return {
    name: "reminder_create",
    arguments: {
      title: title.trim(),
      ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
    },
  };
}

function inferSearchQueryFromHistory(recentMessages: ChatMessage[]): string | null {
  const candidates = [...recentMessages]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim());

  for (const content of candidates) {
    const explicit =
      content.match(
        /(?:search the web|search web|web search|google|look up|lookup)\s+(?:for\s+)?(.+)$/i
      ) ||
      content.match(/(?:who|what|where|when)\s+is\s+(.+)\??$/i) ||
      content.match(/(?:research|deep research|look into|find out about)\s+(.+)$/i);

    if (explicit) {
      const cleaned = cleanSearchQuery(explicit[1]);
      if (cleaned) {
        return cleaned;
      }
    }

    const namedEntity = extractLikelyProperNounQuery(content);
    if (namedEntity) {
      return namedEntity;
    }
  }

  return null;
}

function cleanSearchQuery(value: string): string {
  return value
    .replace(/[?.!]+$/g, "")
    .replace(/^who\s+/i, "")
    .replace(/^what\s+/i, "")
    .trim();
}

function extractLikelyProperNounQuery(content: string): string | null {
  const match = content.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/);

  if (!match) {
    return null;
  }

  const value = match[1].trim();
  return value.length >= 3 ? value : null;
}

function parseGitStatusToolCall(message: string): ToolCall | null {
  if (
    /\bgit status\b/i.test(message) ||
    /\brepo status\b/i.test(message) ||
    /\bworking tree\b/i.test(message) ||
    /\bwhat changed in (?:the )?repo\b/i.test(message) ||
    /\bwhat's the repo status\b/i.test(message)
  ) {
    return {
      name: "git_status",
      arguments: {},
    };
  }

  return null;
}

function parseEmailSearchToolCall(message: string): ToolCall | null {
  const match =
    message.match(/^(?:search|find)\s+(?:my\s+)?email(?:s)?\s+(?:for|about)\s+(.+)$/i) ||
    message.match(/^(?:search|find)\s+emails?\s+from\s+(.+)$/i);

  if (!match) {
    return null;
  }

  return {
    name: "email_search",
    arguments: {
      query: match[1].trim(),
    },
  };
}

function parseEmailSendToolCall(message: string): ToolCall | null {
  const quoted = Array.from(message.matchAll(/"([^"]+)"/g)).map(
    (match) => match[1]
  );
  const toMatch = message.match(
    /\bto\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i
  );

  if (
    /\bsend (?:an )?email\b/i.test(message) &&
    toMatch &&
    quoted.length >= 2
  ) {
    return {
      name: "email_send",
      arguments: {
        to: toMatch[1],
        subject: quoted[0].trim(),
        body: quoted[1].trim(),
      },
    };
  }

  return null;
}

function parseTerminalToolCall(message: string): ToolCall | null {
  const quoted =
    message.match(/`([^`]+)`/) ||
    message.match(/"([^"]+)"/) ||
    message.match(/'([^']+)'/);

  if (
    quoted &&
    /\b(?:run|execute|try|check|inspect)\b/i.test(message) &&
    isAllowedTerminalCommand(quoted[1].trim())
  ) {
    return {
      name: "terminal_run",
      arguments: { command: quoted[1].trim() },
    };
  }

  const runMatch = message.match(/^(?:run|execute)\s+(.+)$/i);
  if (runMatch && isAllowedTerminalCommand(runMatch[1].trim())) {
    return {
      name: "terminal_run",
      arguments: { command: runMatch[1].trim() },
    };
  }

  return null;
}

function splitTextAndDatePhrase(value: string): {
  title: string;
  datePhrase: string | null;
  durationPhrase: string | null;
} | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const datePattern =
    /\b(today|tomorrow|tonight|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|on\s+\d{4}-\d{2}-\d{2}(?:\s+at\s+[^]+?)?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|in\s+\d+\s+(?:minute|minutes|hour|hours|day|days|week|weeks))\b/i;
  const match = datePattern.exec(trimmed);

  if (!match || match.index < 0) {
    return {
      title: trimmed,
      datePhrase: null,
      durationPhrase: null,
    };
  }

  const title = trimmed.slice(0, match.index).trim();
  const remainder = trimmed.slice(match.index).trim();
  const durationMatch = remainder.match(/\bfor\s+(.+)$/i);
  const datePhrase = durationMatch
    ? remainder.slice(0, durationMatch.index).trim()
    : remainder;

  return {
    title,
    datePhrase,
    durationPhrase: durationMatch?.[1]?.trim() || null,
  };
}

function extractCalendarRange(
  message: string
): Record<string, unknown> {
  const lower = message.toLowerCase();
  const today = new Date();

  if (lower.includes("today")) {
    return {
      start: startOfDay(today).toISOString(),
      end: endOfDay(today).toISOString(),
    };
  }

  if (lower.includes("tomorrow")) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      start: startOfDay(tomorrow).toISOString(),
      end: endOfDay(tomorrow).toISOString(),
    };
  }

  if (lower.includes("next week")) {
    const nextWeekStart = startOfWeek(today);
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 7);
    return {
      start: nextWeekStart.toISOString(),
      end: nextWeekEnd.toISOString(),
    };
  }

  return {};
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function startOfWeek(date: Date): Date {
  const result = startOfDay(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function coerceDateTime(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed);
  }

  const normalized = trimmed.toLowerCase().replace(/,/g, "");
  const now = new Date();

  const relativeMatch = normalized.match(
    /^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)$/
  );
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const date = new Date(now);

    if (unit.startsWith("minute")) {
      date.setMinutes(date.getMinutes() + amount);
    } else if (unit.startsWith("hour")) {
      date.setHours(date.getHours() + amount);
    } else if (unit.startsWith("day")) {
      date.setDate(date.getDate() + amount);
    } else {
      date.setDate(date.getDate() + amount * 7);
    }

    return date;
  }

  const dayMatch = normalized.match(
    /^(today|tomorrow|tonight)(?:\s+at\s+(.+))?$/
  );
  if (dayMatch) {
    const date = startOfDay(now);

    if (dayMatch[1] === "tomorrow") {
      date.setDate(date.getDate() + 1);
    }

    if (dayMatch[1] === "tonight" && !dayMatch[2]) {
      date.setHours(20, 0, 0, 0);
      return date;
    }

    const time = parseClockTime(dayMatch[2]);
    applyClockTime(date, time);
    return date;
  }

  const weekdayMatch = normalized.match(
    /^(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/
  );
  if (weekdayMatch) {
    const target = weekdayToNumber(weekdayMatch[1]);
    if (target === null) {
      return null;
    }

    const date = startOfDay(now);
    let delta = target - date.getDay();
    if (delta <= 0 || normalized.startsWith("next ")) {
      delta += 7;
    }
    date.setDate(date.getDate() + delta);
    applyClockTime(date, parseClockTime(weekdayMatch[2]));
    return date;
  }

  const onDateMatch = normalized.match(
    /^(?:on\s+)?(\d{4}-\d{2}-\d{2})(?:\s+at\s+(.+))?$/
  );
  if (onDateMatch) {
    const date = new Date(`${onDateMatch[1]}T09:00:00`);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    applyClockTime(date, parseClockTime(onDateMatch[2]));
    return date;
  }

  const timeOnlyMatch = normalized.match(
    /^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/
  );
  if (timeOnlyMatch) {
    const date = new Date(now);
    applyClockTime(date, parseClockTime(timeOnlyMatch[1]));
    return date;
  }

  return null;
}

function parseClockTime(
  value: string | undefined
): { hours: number; minutes: number } | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "noon") {
    return { hours: 12, minutes: 0 };
  }

  if (normalized === "midnight") {
    return { hours: 0, minutes: 0 };
  }

  if (normalized === "morning") {
    return { hours: 9, minutes: 0 };
  }

  if (normalized === "afternoon") {
    return { hours: 15, minutes: 0 };
  }

  if (normalized === "evening") {
    return { hours: 19, minutes: 0 };
  }

  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    return null;
  }

  let hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] || "0", 10);
  const meridiem = match[3];

  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  }

  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return { hours, minutes };
}

function applyClockTime(
  date: Date,
  time: { hours: number; minutes: number } | null
): void {
  if (!time) {
    date.setHours(9, 0, 0, 0);
    return;
  }

  date.setHours(time.hours, time.minutes, 0, 0);
}

function weekdayToNumber(value: string): number | null {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const index = days.indexOf(value.toLowerCase());
  return index >= 0 ? index : null;
}

function parseDurationMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  let total = 0;
  const matches = normalized.matchAll(
    /(\d+)\s*(minute|minutes|hour|hours|day|days)/g
  );

  for (const match of matches) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];

    if (unit.startsWith("minute")) {
      total += amount * 60 * 1000;
    } else if (unit.startsWith("hour")) {
      total += amount * 60 * 60 * 1000;
    } else {
      total += amount * 24 * 60 * 60 * 1000;
    }
  }

  return total > 0 ? total : null;
}

function summarizeAvailability(
  start: Date,
  end: Date,
  events: Array<{
    title: string;
    startAt: Date;
    endAt: Date;
  }>
) {
  const now = new Date();
  const isBusyNow = events.some(
    (event) => event.startAt <= now && event.endAt >= now
  );
  const nextEvent = events.find((event) => event.startAt >= now) || null;

  return {
    isBusyNow,
    nextEvent,
    totalEvents: events.length,
    windowHours: Math.round((end.getTime() - start.getTime()) / 36e5),
  };
}

async function runControlledTerminalCommand(command: string) {
  const trimmed = command.trim();

  if (!trimmed) {
    throw new Error("Command cannot be empty.");
  }

  if (BLOCKED_COMMAND_PATTERN.test(trimmed)) {
    throw new Error(
      "Blocked shell characters detected. Use a simple read-only command without chaining or redirection."
    );
  }

  if (!isAllowedTerminalCommand(trimmed)) {
    throw new Error(
      "That command is outside Nicole's current safe command set. Right now she can inspect git state, search files, print files, and run repo checks like npm run build/lint/test."
    );
  }

  return new Promise<{
    command: string;
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve, reject) => {
    const shellCommand =
      process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
    const shellArgs =
      process.platform === "win32"
        ? ["-NoProfile", "-Command", trimmed]
        : ["-lc", trimmed];

    const child = spawn(shellCommand, shellArgs, {
      cwd: TOOL_REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill();
      }
    }, TERMINAL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(`${stdout}${String(chunk)}`);
    });

    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(`${stderr}${String(chunk)}`);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      finished = true;
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      finished = true;
      resolve({
        command: trimmed,
        cwd: TOOL_REPO_ROOT,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code,
      });
    });
  });
}

function isAllowedTerminalCommand(command: string): boolean {
  const trimmed = command.trim();

  return ALLOWED_TERMINAL_PREFIXES.some((prefixParts) => {
    const prefix = prefixParts.join(" ");
    return trimmed === prefix || trimmed.startsWith(`${prefix} `);
  });
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TERMINAL_OUTPUT_CHARS)}\n...[truncated]`;
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

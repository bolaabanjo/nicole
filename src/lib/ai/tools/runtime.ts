import { spawn } from "node:child_process";
import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { searchRelevantMemories, storeMemory } from "@/lib/ai/memory";
import type { ActiveOperationalThread } from "@/lib/ai/session-thread";
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
import {
  disconnectIntegration,
  getIntegrationStatus,
  normalizeIntegrationProviderQuery,
  resolveIntegrationProviderQuery,
  startIntegrationConnection,
} from "@/lib/integrations/operations";
import {
  readGmailMessage,
  readGmailThread,
  searchGmail,
  sendGmail,
  sendGmailReply,
} from "@/lib/integrations/gmail";
import {
  readZohoMailMessage,
  readZohoMailThread,
  searchZohoMail,
  sendZohoMail,
  sendZohoMailReply,
} from "@/lib/integrations/zoho-mail";
import { deepResearch } from "@/lib/search/research";
import { searchRelevantSourceChunks } from "@/lib/search/semantic";
import { fetchPageContent, formatSearchResults, searchWeb } from "@/lib/search/web";
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

export interface ToolActivityPreview {
  preActionText?: string;
  statusText?: string;
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
  /\bconnect (?:my |to )?(?:google calendar|calendar|zoho|zoho mail|gmail|google mail|email)\b/i,
  /\bdisconnect (?:my |from )?(?:google calendar|calendar|zoho|zoho mail|gmail|google mail|email)\b/i,
  /\b(?:is|check|show|what(?:'s| is)) .*?(?:connected|integration)\b/i,
  /\bwhat integrations\b/i,
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
  /\b(?:read|open|show) (?:the )?(?:email|mail|message|thread|conversation)\b/i,
  /\bwhat(?:\s+else)?\s+did\s+.+\s+say\b/i,
  /\btell me more about .+(?:email|mail|message)\b/i,
  /\bwhat(?:'s| is| else is) in (?:that|this|the) (?:email|mail|message)\b/i,
  /\bdraft (?:a )?reply\b/i,
  /\bwrite (?:a )?reply\b/i,
  /\bsend (?:that|the|this)?\s*reply\b/i,
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
  workspace_read: async (input) => {
    const { readWorkspaceFile } = await import("@/lib/ai/workspace");
    const path = readRequiredString(input, "path");
    const content = await readWorkspaceFile(path);
    if (content === null) {
      return { ok: false, error: `File not found: ${path}` };
    }
    return { ok: true, path, content };
  },
  workspace_write: async (input) => {
    const { writeWorkspaceFile } = await import("@/lib/ai/workspace");
    const path = readRequiredString(input, "path");
    const content = readRequiredString(input, "content");
    return writeWorkspaceFile(path, content);
  },
  workspace_list: async (input) => {
    const { listWorkspaceFiles } = await import("@/lib/ai/workspace");
    const directory = readOptionalString(input, "directory") || "";
    const files = await listWorkspaceFiles(directory);
    return { directory: directory || "/", files };
  },
  workspace_append_daily: async (input) => {
    const { appendToDailyMemory } = await import("@/lib/ai/workspace");
    const entry = readRequiredString(input, "entry");
    await appendToDailyMemory(entry);
    return { ok: true, entry };
  },
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

    // Auto-fetch full content from the top result for richer answers
    let topResultContent: string | null = null;
    if (response.results.length > 0 && response.status === "ok") {
      try {
        const page = await fetchPageContent(response.results[0].url);
        if (page.text && page.wordCount > 30) {
          // Trim to reasonable size — we don't need 10k words
          const words = page.text.split(/\s+/);
          topResultContent = words.slice(0, 800).join(" ");
        }
      } catch {
        // Fetch failed, snippets are still fine
      }
    }

    return {
      query,
      results: response.results,
      topResultContent,
      provider: response.provider,
      status: response.status,
      liveSearchAvailable: response.liveSearchAvailable,
      warning: response.warning ?? null,
      error: response.error ?? null,
    };
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
  weather_get: async (input) => {
    const { getWeather, formatWeatherForPrompt } = await import("@/lib/integrations/weather");
    const location = readOptionalString(input, "location") || undefined;
    const forecastDays = readOptionalNumber(input, "forecastDays", 3, 1, 7);
    const result = await getWeather(location, forecastDays);
    return { formatted: formatWeatherForPrompt(result), ...result };
  },
  health_metric_read: async (input) => {
    const { getHealthSummary, getHealthForDate, getRecentHealth, formatHealthForPrompt } = await import("@/lib/integrations/health");
    const date = readOptionalString(input, "date");
    const days = readOptionalNumber(input, "days", 7, 1, 30);

    if (date) {
      const data = await getHealthForDate(date);
      if (!data) return { date, data: null, message: `No health data for ${date}.` };
      return { date, data };
    }

    const summary = await getHealthSummary();
    const recent = await getRecentHealth(days);
    return { formatted: formatHealthForPrompt(summary), summary, recent };
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
    const providerHint = normalizeEmailProviderHint(
      readOptionalString(input, "provider")
    );

    if (!providerHint || providerHint === "gmail") {
      const gmailResults = await searchGmail({ query, limit });

      if (gmailResults) {
        return {
          provider: "gmail",
          results: gmailResults,
        };
      }
    }

    if (!providerHint || providerHint === "zoho_mail") {
      const zohoResults = await searchZohoMail({ query, limit });

      if (zohoResults) {
        return {
          provider: "zoho_mail",
          results: zohoResults,
        };
      }
    }

    throw new Error(
      "No supported mail provider is connected yet. Ask Nicole to connect Gmail or Zoho Mail first."
    );
  },
  email_send: async (input) => {
    const to = readRequiredString(input, "to");
    const subject = readRequiredString(input, "subject");
    const body = readRequiredString(input, "body");
    const cc = readOptionalString(input, "cc");
    const gmailResult = await sendGmail({ to, subject, body, cc });

    if (gmailResult) {
      return gmailResult;
    }

    const zohoResult = await sendZohoMail({ to, subject, body, cc });

    if (zohoResult) {
      return zohoResult;
    }

    throw new Error(
      "No supported mail provider is connected yet. Ask Nicole to connect Gmail or Zoho Mail first."
    );
  },
  email_read: async (input) => {
    const reference = await resolveEmailReference(input);
    if (!reference) {
      throw new Error(
        "I couldn't tell which email to open. Ask me to read a numbered result like 'read the first email' after a search."
      );
    }

    if (reference.provider === "gmail") {
      const message = await readGmailMessage({ messageId: reference.id });
      if (message) {
        return {
          provider: "gmail",
          message,
        };
      }
    }

    if (reference.provider === "zoho_mail") {
      const message = await readZohoMailMessage({
        messageId: reference.id,
        folderId: reference.folderId || null,
      });
      if (message) {
        return {
          provider: "zoho_mail",
          message,
        };
      }
    }

    throw new Error("I couldn't load that email.");
  },
  email_thread_read: async (input) => {
    const reference = await resolveEmailReference(input);
    if (!reference) {
      throw new Error(
        "I couldn't tell which thread you meant. Ask me to open the thread for a recent search result first."
      );
    }

    if (reference.provider === "gmail") {
      const threadId = reference.threadId;
      if (!threadId) {
        throw new Error("That Gmail message doesn't have a usable thread id.");
      }

      const thread = await readGmailThread({ threadId });
      if (thread) {
        return thread;
      }
    }

    if (reference.provider === "zoho_mail") {
      const thread = await readZohoMailThread({
        messageId: reference.id,
        folderId: reference.folderId || null,
      });
      if (thread) {
        return thread;
      }
    }

    throw new Error("I couldn't load that email thread.");
  },
  email_reply_draft: async (input) => {
    const reference = await resolveEmailReference(input);
    if (!reference) {
      throw new Error(
        "I couldn't tell which email to reply to. Read an email first or point me at a recent result."
      );
    }

    const instructions =
      readOptionalString(input, "instructions") ||
      "Draft a concise, professional reply that directly addresses the message.";

    const message = await loadEmailMessageForReference(reference);
    if (!message) {
      throw new Error("I couldn't load the original email for drafting.");
    }

    const draft = await draftReplyFromEmail(message, instructions);
    return {
      provider: reference.provider,
      target: {
        messageId: message.id,
        threadId: message.threadId || null,
        subject: message.subject,
        fromAddress: message.fromAddress,
        sender: message.sender,
      },
      draft: {
        to: message.fromAddress,
        subject: draft.subject,
        body: draft.body,
        cc: null,
        originalMessageId: message.id,
        threadId: message.threadId || null,
        messageIdHeader: message.messageIdHeader || null,
        references: message.references || message.messageIdHeader || null,
      },
    };
  },
  email_reply_send: async (input) => {
    const explicitBody = readOptionalString(input, "body");
    const explicitSubject = readOptionalString(input, "subject");
    const explicitCc = readOptionalString(input, "cc");
    const reference = await resolveEmailReference(input);
    const recentDraft = await getLatestEmailReplyDraftOutput(
      normalizeEmailProviderHint(readOptionalString(input, "provider"))
    );

    const draft = recentDraft?.draft || null;
    const provider = reference?.provider || recentDraft?.provider || null;

    if (!provider) {
      throw new Error(
        "I don't have a reply draft ready to send. Ask me to draft the reply first."
      );
    }

    const targetMessage =
      reference ? await loadEmailMessageForReference(reference) : null;
    const originalMessageId =
      readOptionalString(input, "originalMessageId") ||
      targetMessage?.id ||
      draft?.originalMessageId ||
      null;
    const subject =
      explicitSubject || draft?.subject || targetMessage?.subject || null;
    const body = explicitBody || draft?.body || null;
    const cc = explicitCc || draft?.cc || null;
    const to =
      readOptionalString(input, "to") ||
      targetMessage?.fromAddress ||
      draft?.to ||
      null;

    if (!to || !subject || !body || !originalMessageId) {
      throw new Error(
        "I don't have enough reply details yet. Draft the reply first, then ask me to send it."
      );
    }

    if (provider === "gmail") {
      const result = await sendGmailReply({
        to,
        subject,
        body,
        cc,
        threadId:
          readOptionalString(input, "threadId") ||
          targetMessage?.threadId ||
          draft?.threadId ||
          null,
        messageIdHeader:
          readOptionalString(input, "messageIdHeader") ||
          targetMessage?.messageIdHeader ||
          draft?.messageIdHeader ||
          null,
        references:
          readOptionalString(input, "references") ||
          targetMessage?.references ||
          draft?.references ||
          null,
      });

      if (result) {
        return result;
      }
    }

    if (provider === "zoho_mail") {
      const result = await sendZohoMailReply({
        originalMessageId,
        to,
        subject,
        body,
        cc,
      });

      if (result) {
        return result;
      }
    }

    throw new Error("I couldn't send that reply.");
  },
  integration_status: async (input) => {
    const provider = readOptionalString(input, "provider");
    return getIntegrationStatus(provider || undefined);
  },
  integration_connect: async (input) => {
    const provider = readRequiredString(input, "provider");
    const clientSurface = readOptionalString(input, "clientSurface");
    return startIntegrationConnection(provider, {
      clientSurface: clientSurface || undefined,
    });
  },
  integration_disconnect: async (input) => {
    const provider = readRequiredString(input, "provider");
    return disconnectIntegration(provider);
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
- "Who is [name]?" — ALWAYS search unless the person is extremely famous (world leaders, major celebrities). If there is any chance you might hallucinate or confuse the person, search.
- Anything where being wrong would be worse than taking a second to check
- When the user explicitly asks you to look something up
- When you are not confident in the answer and a search would resolve it
- When in doubt between searching and guessing, ALWAYS search. A search that confirms what you knew is free. A guess that's wrong is costly.

When to use web_open:
- After a web_search, when the search snippets are not enough and you need the full page content

When to use workspace tools:
- workspace_read: When you need to check your own files — USER.md, CONTEXT.md, MEMORY.md, daily notes, or skill definitions
- workspace_write: When you learn something durable about Roy (update USER.md or MEMORY.md), or need to update your current context (CONTEXT.md)
- workspace_append_daily: When something notable happens worth logging — a decision, a completed task, a new preference learned
- workspace_list: When you need to see what's in your workspace directories

When NOT to use tools:
- Casual conversation, greetings, emotional support, opinions, advice
- Math, definitions, or universally known facts (e.g. "what is photosynthesis", "what's 2+2")
- Follow-up messages in an ongoing conversation where context is already available
- Do NOT skip web_search just because the name sounds familiar. If you cannot cite a specific source for your answer, search.

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

// ---------------------------------------------------------------------------
// Intent-based tool execution — deterministic, no LLM planner
// ---------------------------------------------------------------------------

import { classifyIntent, IntentClassification } from "@/lib/ai/intent";

export { classifyIntent };
export type { IntentClassification };

/**
 * Deterministic tool runner. Takes a classified intent and executes the
 * appropriate tools without asking the LLM "should I use a tool?".
 *
 * Returns tool results that get injected into the system prompt.
 */
export async function runIntentBasedTooling(
  intent: IntentClassification,
  message: string,
  recentMessages: ChatMessage[] = [],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  const toolCalls = resolveIntentToolCalls(
    intent,
    message,
    recentMessages,
    clientSurface,
    activeThread
  );

  for (const toolCall of toolCalls) {
    results.push(await executeToolCall(toolCall));
  }

  return results;
}

export function describeIntentToolActivity(
  intent: IntentClassification,
  message: string,
  recentMessages: ChatMessage[] = [],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): ToolActivityPreview | null {
  const [firstToolCall] = resolveIntentToolCalls(
    intent,
    message,
    recentMessages,
    clientSurface,
    activeThread
  );

  if (!firstToolCall) {
    return null;
  }

  switch (firstToolCall.name) {
    case "integration_status":
      return {
        preActionText: "Let me check what accounts you have connected.",
        statusText: "Checking your connected accounts",
      };
    case "integration_connect":
      return {
        preActionText: "Sure, let's get that connected.",
        statusText: "Starting the connection flow",
      };
    case "integration_disconnect":
      return {
        preActionText: "Hold on, let me take care of that for you.",
        statusText: "Updating your connected accounts",
      };
    case "web_search":
      return {
        preActionText: "Good question, let me look that up.",
        statusText: "Searching the web",
      };
    case "deep_research":
      return {
        preActionText: "That's a bit complex, let me do some deeper research.",
        statusText: "Researching this",
      };
    case "calendar_read":
      return {
        preActionText: "Let me see what's on your calendar.",
        statusText: "Checking your calendar",
      };
    case "calendar_create_event":
      return {
        preActionText: "Let me get that on your calendar for you.",
        statusText: "Creating your calendar event",
      };
    case "reminder_create":
      return {
        preActionText: "Sure, I'll set that reminder for you.",
        statusText: "Creating your reminder",
      };
    case "email_search":
      return {
        preActionText: "Let me check your inbox for that.",
        statusText: "Checking your email",
      };
    case "email_read":
      return {
        preActionText: "Let me open that email for you.",
        statusText: "Reading that email",
      };
    case "email_thread_read":
      return {
        preActionText: "Let me pull up that conversation.",
        statusText: "Reading that conversation",
      };
    case "email_reply_draft":
      return {
        preActionText: "I'll draft a reply for you right now.",
        statusText: "Drafting your reply",
      };
    case "email_reply_send":
    case "email_send":
      return {
        preActionText: "I'll get that sent off for you.",
        statusText: "Sending your email",
      };
    case "source_search":
      return {
        preActionText: "Let me check your library.",
        statusText: "Searching your notes and sources",
      };
    case "workspace_read":
    case "workspace_list":
      return {
        preActionText: "Let me check my workspace for you.",
        statusText: "Checking Nicole's workspace",
      };
    case "git_status":
      return {
        preActionText: "Let me check the repository status.",
        statusText: "Checking the repo",
      };
    case "terminal_run":
      return {
        preActionText: "I'll run that command for you.",
        statusText: "Running that command",
      };
    case "weather_get":
      return {
        preActionText: "Let me check the weather for you.",
        statusText: "Checking the weather",
      };
    case "health_metric_read":
      return {
        preActionText: "Let me pull up your health data.",
        statusText: "Reading health metrics",
      };
    default:
      return {
        preActionText: "Give me just a second to check that.",
        statusText: "Working on it",
      };
  }
}

export function previewIntentToolCalls(
  intent: IntentClassification,
  message: string,
  recentMessages: ChatMessage[] = [],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): ToolCall[] {
  return resolveIntentToolCalls(
    intent,
    message,
    recentMessages,
    clientSurface,
    activeThread
  );
}

export async function generateToolActivityPreface(
  message: string,
  preview: ToolActivityPreview
): Promise<string | null> {
  const fallback = preview.preActionText?.trim() || null;
  const statusText = preview.statusText?.trim();

  if (!fallback && !statusText) {
    return null;
  }

  try {
    const prefacePromise = chat(
      [
        {
          role: "system",
          content: `You write a single short, warm, and natural pre-action line that Nicole says before performing a task or using a tool.

Rules:
- Output exactly one short sentence.
- Maximum 12 words.
- Sound conversational, empathetic, and direct. Avoid sounding like a computer.
- Examples: "Let me check that for you.", "I'll pull that up right now.", "Hold on, let me find that.", "I'm on it, let me check your calendar."
- Use first person ("I", "I'll", "Me").
- Do not mention tool names, APIs, JSON, or internal processes.
- Do not announce the result yet.
- Do not use markdown, quotes, or labels.`,
        },
        {
          role: "user",
          content: `Roy asked: ${message}\n\nNicole is about to do this: ${statusText || "check something for Roy"}.\n\nWrite the one-sentence pre-action line Nicole should say right before that starts.`,
        },
      ],
      {
        temperature: 0.7,
        maxTokens: 24,
      }
    );

    const result = await Promise.race([
      prefacePromise,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(fallback || ""), 900)
      ),
    ]);

    const text = (typeof result === "string" ? result : String(result))
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) {
      return fallback;
    }

    return text;
  } catch {
    return fallback;
  }
}

export function buildToolActivityFeedEntries(
  toolResults: ToolExecutionResult[]
): string[] {
  return toolResults.flatMap((result) => buildSingleToolActivityEntries(result));
}

export function buildDirectToolResponse(
  toolResults: ToolExecutionResult[]
): string | null {
  if (toolResults.length === 0) {
    return null;
  }

  const supported = toolResults.every((result) =>
    [
      "integration_status",
      "integration_connect",
      "integration_disconnect",
      "calendar_read",
      "calendar_create_event",
      "email_search",
      "email_read",
      "email_thread_read",
      "email_reply_draft",
      "email_reply_send",
      "email_send",
    ].includes(result.name)
  );

  if (!supported) {
    return null;
  }

  const lines = toolResults
    .map((result) => buildDirectSingleToolResponse(result))
    .filter((line): line is string => Boolean(line?.trim()));

  return lines.length > 0 ? lines.join("\n\n") : null;
}

function buildSingleToolActivityEntries(
  result: ToolExecutionResult
): string[] {
  if (!result.ok) {
    switch (result.name) {
      case "integration_status":
      case "integration_connect":
      case "integration_disconnect":
        return ["Couldn't check your connected accounts"];
      case "email_search":
      case "email_read":
      case "email_thread_read":
      case "email_reply_draft":
      case "email_reply_send":
      case "email_send":
        return ["Couldn't complete that email action"];
      case "calendar_read":
      case "calendar_create_event":
        return ["Couldn't complete that calendar action"];
      case "web_search":
      case "deep_research":
        return ["Couldn't finish that web lookup"];
      default:
        return ["Couldn't finish that step"];
    }
  }

  switch (result.name) {
    case "integration_status":
      return buildIntegrationStatusActivityEntries(result.output);
    case "integration_connect":
      return buildIntegrationConnectActivityEntries(result.output);
    case "integration_disconnect":
      return buildIntegrationDisconnectActivityEntries(result.output);
    case "web_search":
      return buildWebSearchActivityEntries(result);
    case "deep_research":
      return ["Finished gathering research sources"];
    case "calendar_read":
      return buildCalendarReadActivityEntries(result.output);
    case "calendar_create_event":
      return buildCalendarCreateActivityEntries(result.output);
    case "reminder_create":
      return buildReminderCreateActivityEntries(result.output);
    case "email_search":
      return buildEmailSearchActivityEntries(result.output);
    case "email_read":
      return buildEmailReadActivityEntries(result.output);
    case "email_thread_read":
      return buildEmailThreadActivityEntries(result.output);
    case "email_reply_draft":
      return ["Drafted your reply"];
    case "email_reply_send":
      return ["Sent your reply"];
    case "email_send":
      return ["Sent your email"];
    case "source_search":
      return ["Searched your notes and sources"];
    case "workspace_read":
      return ["Checked Nicole's workspace"];
    case "workspace_list":
      return ["Listed Nicole's workspace files"];
    case "git_status":
      return ["Checked the repo status"];
    case "terminal_run":
      return ["Ran that command"];
    default:
      return [`Finished ${humanizeToolName(result.name)}`];
  }
}

function buildDirectSingleToolResponse(
  result: ToolExecutionResult
): string | null {
  if (
    result.name !== "integration_status" &&
    result.name !== "integration_connect" &&
    result.name !== "integration_disconnect" &&
    result.name !== "calendar_read" &&
    result.name !== "calendar_create_event" &&
    result.name !== "email_search" &&
    result.name !== "email_read" &&
    result.name !== "email_thread_read" &&
    result.name !== "email_reply_draft" &&
    result.name !== "email_reply_send" &&
    result.name !== "email_send"
  ) {
    return null;
  }

  if (!result.ok) {
    return result.error || "I couldn't complete that action.";
  }

  if (result.name === "calendar_read") {
    return buildDirectCalendarReadResponse(result.output);
  }

  if (result.name === "calendar_create_event") {
    return buildDirectCalendarCreateResponse(result.output);
  }

  if (result.name === "email_search") {
    return buildDirectEmailSearchResponse(result.output);
  }

  if (result.name === "email_read") {
    return buildDirectEmailReadResponse(result.output);
  }

  if (result.name === "email_thread_read") {
    return buildDirectEmailThreadReadResponse(result.output);
  }

  if (result.name === "email_reply_draft") {
    return buildDirectEmailReplyDraftResponse(result.output);
  }

  if (result.name === "email_reply_send" || result.name === "email_send") {
    return buildDirectEmailSendResponse(result.output);
  }

  const output = asIntegrationToolOutput(result.output);
  if (!output) {
    return "I couldn't read that integration result clearly.";
  }

  if (output.ok === false) {
    return output.message || "That integration request couldn't be completed.";
  }

  if (result.name === "integration_connect") {
    const providerTitle = output.provider?.title || "that integration";

    if (output.provider?.connected) {
      return `${providerTitle} is already connected.`;
    }

    if (output.browserOpened) {
      return `I opened the ${providerTitle} sign-in flow in your browser. Finish the consent there, then come back to me.`;
    }

    if (output.connectUrl) {
      return `${providerTitle} is ready to connect. Open this link to finish the consent: ${output.connectUrl}`;
    }

    return output.message || `I started the ${providerTitle} connection flow.`;
  }

  if (result.name === "integration_disconnect") {
    return (
      output.message ||
      `${output.provider?.title || "That integration"} is disconnected now.`
    );
  }

  if (Array.isArray(output.allProviders) && output.allProviders.length > 0) {
    return output.allProviders
      .map((provider) => {
        const title = provider.title || "Unknown integration";
        if (provider.connected) {
          return `${title} is connected.`;
        }

        if (provider.status === "planned") {
          return `${title} is planned but not wired yet.`;
        }

        if (provider.configured) {
          return `${title} is available but not connected yet.`;
        }

        return `${title} is not configured on this Mac yet.`;
      })
      .join("\n");
  }

  if (output.provider?.title) {
    const title = output.provider.title;
    if (output.provider.connected) {
      return `${title} is connected.`;
    }

    if (output.provider.status === "planned") {
      return `${title} is planned, but it isn't wired yet.`;
    }

    if (output.provider.configured) {
      return `${title} is available but not connected yet.`;
    }

    return `${title} is not configured on this Mac yet.`;
  }

  return output.message || "I checked that integration status for you.";
}

function buildDirectCalendarReadResponse(output: unknown): string {
  const record = output as
    | {
        events?: Array<{
          title?: string;
          startAt?: string | Date;
          endAt?: string | Date;
        }>;
      }
    | undefined;

  const events = Array.isArray(record?.events) ? record.events : [];

  if (events.length === 0) {
    return "I checked your calendar and I didn't find anything in that window.";
  }

  const lines = events.slice(0, 5).map((event) => {
    const title = event.title?.trim() || "Untitled event";
    const start = formatCalendarDateTime(event.startAt);
    const end = formatCalendarDateTime(event.endAt, { omitDateIfSameDayAs: event.startAt });
    return end ? `${title} — ${start} to ${end}` : `${title} — ${start}`;
  });

  const intro =
    events.length === 1
      ? "I found 1 event on your calendar:"
      : `I found ${events.length} events on your calendar:`;

  return `${intro}\n- ${lines.join("\n- ")}`;
}

function buildDirectCalendarCreateResponse(output: unknown): string {
  const record = output as
    | {
        event?: {
          title?: string;
          startAt?: string | Date;
          endAt?: string | Date;
        };
      }
    | undefined;

  const title = record?.event?.title?.trim() || "That event";
  const start = formatCalendarDateTime(record?.event?.startAt);
  const end = formatCalendarDateTime(record?.event?.endAt, {
    omitDateIfSameDayAs: record?.event?.startAt,
  });

  if (start && end) {
    return `${title} is on your calendar for ${start} to ${end}.`;
  }

  if (start) {
    return `${title} is on your calendar for ${start}.`;
  }

  return `${title} is on your calendar now.`;
}

function buildDirectEmailSearchResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        results?: Array<{
          subject?: string;
          sender?: string;
          fromAddress?: string;
          summary?: string;
          receivedAt?: string;
        }>;
      }
    | undefined;

  const provider = formatEmailProviderTitle(record?.provider);
  const results = Array.isArray(record?.results) ? record.results : [];

  if (results.length === 0) {
    return `I checked ${provider} and I didn't find matching emails.`;
  }

  const lines = results.slice(0, 5).map((item) => {
    const subject = item.subject?.trim() || "(no subject)";
    const sender = item.sender || item.fromAddress || "unknown sender";
    const summary = item.summary?.trim();

    return summary
      ? `${subject} — from ${sender}. ${summary}`
      : `${subject} — from ${sender}`;
  });

  const intro =
    results.length === 1
      ? `I found 1 email in ${provider}:`
      : `I found ${results.length} emails in ${provider}:`;

  return `${intro}\n- ${lines.join("\n- ")}`;
}

function buildDirectEmailReadResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        message?: {
          subject?: string;
          sender?: string;
          fromAddress?: string;
          bodyText?: string;
          summary?: string;
        };
      }
    | undefined;

  const provider = formatEmailProviderTitle(record?.provider);
  const message = record?.message;
  const subject = message?.subject?.trim() || "(no subject)";
  const sender = message?.sender || message?.fromAddress || "unknown sender";
  const body = (message?.bodyText || message?.summary || "").trim();

  if (!body) {
    return `I opened “${subject}” in ${provider}. It's from ${sender}. I couldn't extract a readable body from it.`;
  }

  const clipped = body.slice(0, 900);
  return `I opened “${subject}” in ${provider}. It's from ${sender}.\n\n${clipped}${body.length > clipped.length ? "..." : ""}`;
}

function buildDirectEmailThreadReadResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        messages?: Array<{
          subject?: string;
          sender?: string;
          fromAddress?: string;
          bodyText?: string;
        }>;
        thread?: {
          messages?: Array<{
            subject?: string;
            sender?: string;
            fromAddress?: string;
            bodyText?: string;
          }>;
        };
        note?: string;
      }
    | undefined;

  const provider = formatEmailProviderTitle(record?.provider);
  const messages = Array.isArray(record?.messages)
    ? record.messages
    : Array.isArray(record?.thread?.messages)
      ? record.thread.messages
      : [];

  if (messages.length === 0) {
    return `I opened that thread in ${provider}, but I couldn't extract any readable messages from it.`;
  }

  const lines = messages.slice(0, 5).map((message, index) => {
    const subject = message.subject?.trim() || "(no subject)";
    const sender = message.sender || message.fromAddress || "unknown sender";
    const body = message.bodyText?.trim();
    const clipped = body ? body.slice(0, 220) : "";
    const detail = clipped ? ` ${clipped}${body && body.length > clipped.length ? "..." : ""}` : "";
    return `${index + 1}. ${subject} — from ${sender}.${detail}`;
  });

  return [
    `I opened that thread in ${provider}.`,
    ...lines,
    record?.note?.trim() ? `Note: ${record.note.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDirectEmailReplyDraftResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        draft?: {
          to?: string;
          subject?: string;
          body?: string;
        };
      }
    | undefined;

  const provider = formatEmailProviderTitle(record?.provider);
  const subject = record?.draft?.subject?.trim() || "(no subject)";
  const to = record?.draft?.to?.trim() || "the intended recipient";
  const body = record?.draft?.body?.trim() || "";
  const clipped = body.slice(0, 600);

  return [
    `I drafted a reply in ${provider} to ${to}.`,
    `Subject: ${subject}`,
    clipped ? `Draft:\n${clipped}${body.length > clipped.length ? "..." : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildDirectEmailSendResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        sent?: {
          to?: string | string[];
          subject?: string;
        };
      }
    | undefined;

  const provider = formatEmailProviderTitle(record?.provider);
  const to = Array.isArray(record?.sent?.to)
    ? record?.sent?.to?.join(", ")
    : record?.sent?.to;
  const subject = record?.sent?.subject?.trim();

  if (to && subject) {
    return `I sent that email in ${provider} to ${to} with the subject “${subject}.”`;
  }

  if (subject) {
    return `I sent that email in ${provider} with the subject “${subject}.”`;
  }

  return `I sent that email in ${provider}.`;
}

function formatCalendarDateTime(
  value: string | Date | undefined,
  options?: { omitDateIfSameDayAs?: string | Date | undefined }
): string {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const baseFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const timeOnlyFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (options?.omitDateIfSameDayAs) {
    const compare =
      options.omitDateIfSameDayAs instanceof Date
        ? options.omitDateIfSameDayAs
        : new Date(options.omitDateIfSameDayAs);

    if (
      !Number.isNaN(compare.getTime()) &&
      compare.getFullYear() === date.getFullYear() &&
      compare.getMonth() === date.getMonth() &&
      compare.getDate() === date.getDate()
    ) {
      return timeOnlyFormatter.format(date);
    }
  }

  return baseFormatter.format(date);
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
    /\b(search|look up|lookup|research|find out|web|source|sources|library|pdf|document|notes?|remember|save this|store this|list tools|what can you do|create note|update note|write this down|write that down|note that|update your|update my profile|what do you know about me|your workspace|your files|your memory|your notes|daily note|jot this down)\b/.test(
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

  // Factual questions about people, places, things — likely need search
  if (
    /^(who is|who are|who was|what is|what are|what was|where is|where are|when is|when was|when did|how old is|how much is|how many|tell me about|what happened to|what do you know about)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  // Questions ending with ? that aren't casual — probably need tools
  if (normalized.endsWith("?") && normalized.length > 20) {
    return true;
  }

  return false;
}

function resolveIntentToolCalls(
  intent: IntentClassification,
  message: string,
  recentMessages: ChatMessage[] = [],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): ToolCall[] {
  switch (intent.intent) {
    case "casual":
      return [];

    case "factual_question":
      if (intent.searchQuery) {
        return [
          {
            name: "web_search",
            arguments: { query: intent.searchQuery, limit: 5 },
          },
        ];
      }
      return [];

    case "source_question":
      if (intent.sourceQuery) {
        return [
          {
            name: "source_search",
            arguments: { query: intent.sourceQuery, limit: 6 },
          },
        ];
      }
      return [];

    case "weather_question":
      return [
        {
          name: "weather_get",
          arguments: {
            ...(intent.weatherLocation ? { location: intent.weatherLocation } : {}),
            forecastDays: 3,
          },
        },
      ];

    case "health_question":
      return [{ name: "health_metric_read", arguments: {} }];

    case "personal_question":
    case "action_request":
    case "workspace_question":
    case "ambiguous": {
      const directCall = detectDirectToolCall(
        message,
        recentMessages,
        clientSurface,
        activeThread
      );
      return directCall ? [directCall] : [];
    }
  }
}

function buildIntegrationStatusActivityEntries(output: unknown): string[] {
  const record = output as
    | {
        provider?: { title?: string; connected?: boolean; configured?: boolean; status?: string };
        allProviders?: Array<{
          title?: string;
          connected?: boolean;
          configured?: boolean;
          status?: string;
        }>;
      }
    | undefined;

  if (Array.isArray(record?.allProviders) && record.allProviders.length > 0) {
    return record.allProviders.slice(0, 4).map((provider) => {
      const title = provider.title || "This integration";
      if (provider.connected) {
        return `${title} is connected`;
      }

      if (provider.status === "planned") {
        return `${title} is planned`;
      }

      if (provider.configured) {
        return `${title} isn't connected yet`;
      }

      return `${title} isn't configured yet`;
    });
  }

  if (record?.provider?.title) {
    const title = record.provider.title;
    if (record.provider.connected) {
      return [`${title} is connected`];
    }

    if (record.provider.status === "planned") {
      return [`${title} is planned`];
    }

    if (record.provider.configured) {
      return [`${title} isn't connected yet`];
    }

    return [`${title} isn't configured yet`];
  }

  return ["Checked your connected accounts"];
}

function buildIntegrationConnectActivityEntries(output: unknown): string[] {
  const record = output as
    | { provider?: { title?: string }; browserOpened?: boolean; connectUrl?: string | null }
    | undefined;
  const title = record?.provider?.title || "that integration";

  if (record?.browserOpened) {
    return [`Opened the ${title} sign-in page`];
  }

  if (record?.connectUrl) {
    return [`Prepared the ${title} connection flow`];
  }

  return [`Started the ${title} connection flow`];
}

function buildIntegrationDisconnectActivityEntries(output: unknown): string[] {
  const record = output as { provider?: { title?: string } } | undefined;
  if (record?.provider?.title) {
    return [`Disconnected ${record.provider.title}`];
  }

  return ["Disconnected that integration"];
}

function buildWebSearchActivityEntries(result: ToolExecutionResult): string[] {
  const output = asWebSearchToolOutput(result.output);
  const query =
    typeof result.input.query === "string" && result.input.query.trim().length > 0
      ? result.input.query.trim()
      : null;

  if (!output || output.status !== "ok") {
    return query
      ? [`Searched the web for “${query}”`]
      : ["Searched the web"];
  }

  const resultCount = Array.isArray(output.results) ? output.results.length : 0;
  if (query && resultCount > 0) {
    return [`Found ${resultCount} web result${resultCount === 1 ? "" : "s"} for “${query}”`];
  }

  if (resultCount > 0) {
    return [`Found ${resultCount} web result${resultCount === 1 ? "" : "s"}`];
  }

  return query
    ? [`Searched the web for “${query}”`]
    : ["Searched the web"];
}

function buildCalendarReadActivityEntries(output: unknown): string[] {
  const record = output as { events?: unknown[] } | undefined;
  const eventCount = Array.isArray(record?.events) ? record!.events!.length : 0;
  if (eventCount > 0) {
    return [`Checked your calendar`, `Found ${eventCount} upcoming event${eventCount === 1 ? "" : "s"}`];
  }

  return ["Checked your calendar"];
}

function buildCalendarCreateActivityEntries(output: unknown): string[] {
  const record = output as { event?: { title?: string } } | undefined;
  if (record?.event?.title) {
    return [`Created “${record.event.title}” on your calendar`];
  }

  return ["Created your calendar event"];
}

function buildReminderCreateActivityEntries(output: unknown): string[] {
  const record = output as { reminder?: { title?: string } } | undefined;
  if (record?.reminder?.title) {
    return [`Created the reminder “${record.reminder.title}”`];
  }

  return ["Created your reminder"];
}

function buildEmailSearchActivityEntries(output: unknown): string[] {
  const record = output as { provider?: string; results?: unknown[] } | undefined;
  const providerTitle = formatEmailProviderTitle(record?.provider);
  const resultCount = Array.isArray(record?.results) ? record!.results!.length : 0;

  if (resultCount > 0) {
    return [`Found ${resultCount} email${resultCount === 1 ? "" : "s"} in ${providerTitle}`];
  }

  return [`Checked ${providerTitle}`];
}

function buildEmailReadActivityEntries(output: unknown): string[] {
  const record = output as { message?: { subject?: string } } | undefined;
  if (record?.message?.subject) {
    return [`Opened “${record.message.subject}”`];
  }

  return ["Opened that email"];
}

function buildEmailThreadActivityEntries(output: unknown): string[] {
  const record = output as
    | { messages?: unknown[]; thread?: { messages?: unknown[] } }
    | undefined;
  const messages =
    Array.isArray(record?.messages)
      ? record?.messages
      : Array.isArray(record?.thread?.messages)
        ? record?.thread?.messages
        : [];

  if (messages.length > 0) {
    return [`Opened the email thread`, `Loaded ${messages.length} message${messages.length === 1 ? "" : "s"} in that conversation`];
  }

  return ["Opened the email thread"];
}

function formatEmailProviderTitle(provider: unknown): string {
  if (provider === "gmail") {
    return "Gmail";
  }

  if (provider === "zoho_mail") {
    return "Zoho Mail";
  }

  return "your email";
}

function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ");
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
      if (result.name === "web_search") {
        return formatWebSearchToolResult(result);
      }

      if (result.name === "weather_get") {
        return formatWeatherToolResult(result);
      }

      if (
        result.name === "email_search" ||
        result.name === "email_read" ||
        result.name === "email_thread_read" ||
        result.name === "email_reply_draft" ||
        result.name === "email_reply_send"
      ) {
        return formatEmailToolResult(result);
      }

      if (
        result.name === "integration_status" ||
        result.name === "integration_connect" ||
        result.name === "integration_disconnect"
      ) {
        return formatIntegrationToolResult(result);
      }

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

/**
 * Clean text version of tool results — used when injecting into a user message
 * (for search/weather). No meta-instructions, just the data.
 */
export function buildToolResultsText(toolResults: ToolExecutionResult[]): string {
  return toolResults
    .map((result) => {
      if (!result.ok) {
        return `Search failed: ${result.error || "unavailable"}`;
      }

      if (result.name === "web_search") {
        const output = asWebSearchToolOutput(result.output);
        if (!output || output.status !== "ok") {
          return `Web search returned no usable results.`;
        }

        const results = Array.isArray(output.results)
          ? output.results.filter(
              (item) =>
                typeof item?.title === "string" &&
                item.title.trim().length > 0
            )
          : [];

        const lines = results.map((item, i) => {
          const title = item.title!.trim();
          const url = item.url?.trim() || "";
          const content = typeof item.content === "string" ? item.content.trim() : "";
          return `${i + 1}. ${title}\n   URL: ${url}${content ? `\n   ${content}` : ""}`;
        });

        let text = lines.join("\n\n");

        if (typeof output.topResultContent === "string" && output.topResultContent.length > 0) {
          text += `\n\n--- Full content from top result ---\n${output.topResultContent}`;
        }

        return text;
      }

      if (result.name === "weather_get") {
        const output = result.output as { formatted?: string };
        return output?.formatted || JSON.stringify(result.output, null, 2);
      }

      return JSON.stringify(result.output, null, 2);
    })
    .join("\n\n");
}

export function buildToolPromptBlock(toolResults: ToolExecutionResult[]): string {
  const toolContext = formatToolResultsForPrompt(toolResults);
  if (!toolContext) {
    return "";
  }

  return `\n\n## Tool results\nNicole called tools before answering. CRITICAL RULES:\n- Treat tool results as the source of truth for current or external information.\n- For non-search tools, base your answer only on the tool results below.\n- If web_search says live Google search was unavailable, say that clearly first. Then you may give a cautious fallback answer from your prior knowledge, but you must label it as not verified by live Google search.\n- If web_search says the live results were thin or inconclusive, say that clearly first. Then you may give a cautious fallback answer, clearly labeled as not fully verified by live Google search.\n- If web_search returned usable live results, answer from those live results and do not present prior knowledge as if it came from live search.\n- Never claim to have searched the web if the tool says live search failed or was weak.\n- Never claim to have read, drafted, or sent email unless the corresponding email_* tool result is present below.\n- If integration_connect says the browser was opened, tell Roy to finish the official sign-in flow there. Do not send him to /integrations.\n- If integration_connect returns a connectUrl without opening the browser, give him that URL plainly and tell him to finish the consent there.\n- If integration_status or integration_disconnect returns provider state, treat that state as the truth.\n- Do not expose internal tool mechanics unless the user explicitly asks.\n\n${toolContext}`;
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
  recentMessages: ChatMessage[] = [],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): ToolCall | null {
  const trimmed = normalizeDirectToolMessage(message);

  if (!trimmed) {
    return null;
  }

  return (
    parseIntegrationConnectToolCall(
      trimmed,
      recentMessages,
      clientSurface,
      activeThread
    ) ||
    parseIntegrationDisconnectToolCall(trimmed) ||
    parseIntegrationStatusToolCall(trimmed) ||
    parseWebSearchToolCall(trimmed, recentMessages) ||
    parseDeepResearchToolCall(trimmed, recentMessages) ||
    parseReminderToolCall(trimmed) ||
    parseCalendarCreateToolCall(trimmed) ||
    parseCalendarReadToolCall(trimmed) ||
    parseEmailSearchToolCall(trimmed) ||
    parseEmailFollowUpToolCall(trimmed) ||
    parseEmailThreadReadToolCall(trimmed) ||
    parseEmailReadToolCall(trimmed) ||
    parseEmailReplyDraftToolCall(trimmed) ||
    parseEmailReplySendToolCall(trimmed) ||
    parseEmailSendToolCall(trimmed) ||
    parseGitStatusToolCall(trimmed) ||
    parseTerminalToolCall(trimmed) ||
    parseToolRegistryCall(trimmed) ||
    parseWorkspaceToolCall(trimmed)
  );
}

function parseWebSearchToolCall(
  message: string,
  recentMessages: ChatMessage[]
): ToolCall | null {
  const normalizedMessage = normalizeDirectToolMessage(message);
  const explicitMatch = message.match(
    /^(?:please\s+)?(?:can you\s+|could you\s+|i need you to\s+|i want you to\s+)?(?:search|search the web|search web|web search|google|look up|lookup)\s+(?:the web\s+)?(?:for\s+)?(.+)$/i
  );

  if (explicitMatch) {
    const query = cleanSearchQuery(explicitMatch[1]);
    if (query) {
      const providerResolution = resolveIntegrationProviderQuery(query);
      const wholeMessageProviderResolution =
        resolveIntegrationProviderQuery(normalizedMessage);
      const normalizedQuery = normalizeIntegrationProviderQuery(query);
      if (
        /^google\s+/i.test(normalizedMessage) &&
        (providerResolution.provider ||
          wholeMessageProviderResolution.provider ||
          /\b(calendar|gcal|mail|gmail|zoho|reminder|reminders|apple)\b/i.test(
            normalizedQuery
          ) ||
          /\b(connected|connection|auth|oauth|sign in|signin|linked|set up|setup)\b/i.test(
            normalizedQuery
          ))
      ) {
        return null;
      }

      return {
        name: "web_search",
        arguments: { query, limit: 5 },
      };
    }
  }

  // "Who is X?" / "What is X?" / "Tell me about X" → direct web search
  // This bypasses the LLM planner which tends to hallucinate answers for unfamiliar names.
  const factualMatch = message.match(
    /^(?:who is|who are|who was|what is|what are|what was|tell me about|what do you know about)\s+(.+?)(?:\?|\.)?$/i
  );
  if (factualMatch) {
    const subject = cleanSearchQuery(factualMatch[1]);
    if (subject && subject.length > 1) {
      return {
        name: "web_search",
        arguments: { query: subject, limit: 5 },
      };
    }
  }

  if (
    /^(?:google|search the web|search web)\s+(?:for\s+)?(?:him|her|them|it)\.?$/i.test(
      message
    ) ||
    /^look\s+(?:him|her|them|it)\s+up\.?$/i.test(message) ||
    /^lookup\s+(?:him|her|them|it)\.?$/i.test(message)
  ) {
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
    /^(?:please\s+)?(?:can you\s+|could you\s+|i need you to\s+|i want you to\s+)?(?:research|deep research|look into|find out about)\s+(.+)$/i
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

function parseIntegrationConnectToolCall(
  message: string,
  recentMessages: ChatMessage[],
  clientSurface?: string,
  activeThread?: ActiveOperationalThread | null
): ToolCall | null {
  const normalizedMessage = normalizeDirectToolMessage(message);
  const activeIntegrationAction =
    activeThread?.kind === "integration" ? activeThread.action : null;
  const explicitMatch = message.match(
    /^(?:please\s+)?(?:can you\s+|could you\s+|i need you to\s+|i want you to\s+|i(?:'d| would)\s+like to\s+)?(?:connect|link|hook up|set up)\s+(?:my\s+)?(.+?)(?:\s+(?:for me|please))?[.!?]*$/i
  );

  if (explicitMatch) {
    const provider = cleanIntegrationProviderQuery(explicitMatch[1]);
    if (provider && looksLikeIntegrationProviderQuery(provider)) {
      return {
        name: "integration_connect",
        arguments: {
          provider,
          ...(clientSurface ? { clientSurface } : {}),
        },
      };
    }
  }

  const bareProviderResolution = resolveIntegrationProviderQuery(normalizedMessage);
  if (
    bareProviderResolution.provider &&
    (activeIntegrationAction === "connect" ||
      (!activeIntegrationAction &&
        isActiveIntegrationConversation(recentMessages, activeThread)))
  ) {
    return {
      name: "integration_connect",
      arguments: {
        provider: bareProviderResolution.provider.id,
        ...(clientSurface ? { clientSurface } : {}),
      },
    };
  }

  if (/^(?:connect|link|set up)\s+(?:him|her|them|it)\.?$/i.test(message)) {
    const inferred = inferIntegrationQueryFromHistory(recentMessages, activeThread);
    if (inferred) {
      return {
        name: "integration_connect",
        arguments: {
          provider: inferred,
          ...(clientSurface ? { clientSurface } : {}),
        },
      };
    }
  }

  if (looksLikeIntegrationConnectFollowUp(message)) {
    const inferred = inferIntegrationQueryFromHistory(recentMessages, activeThread);
    if (inferred) {
      return {
        name: "integration_connect",
        arguments: {
          provider: inferred,
          ...(clientSurface ? { clientSurface } : {}),
        },
      };
    }
  }

  return null;
}

function parseIntegrationDisconnectToolCall(message: string): ToolCall | null {
  const match = message.match(
    /^(?:please\s+)?(?:can you\s+|could you\s+|i need you to\s+|i want you to\s+)?disconnect\s+(?:my\s+)?(.+?)(?:\s+(?:for me|please))?[.!?]*$/i
  );

  if (!match) {
    return null;
  }

  const provider = cleanIntegrationProviderQuery(match[1]);
  if (!provider || !looksLikeIntegrationProviderQuery(provider)) {
    return null;
  }

  return {
    name: "integration_disconnect",
    arguments: { provider },
  };
}

function parseIntegrationStatusToolCall(message: string): ToolCall | null {
  const normalizedMessage = normalizeDirectToolMessage(message);

  if (
    /\bwhat integrations(?: do you have| are connected)?\b/i.test(message) ||
    /\bshow (?:me )?(?:your |my )?integrations\b/i.test(message) ||
    /\bwhat'?s connected\b/i.test(message)
  ) {
    return {
      name: "integration_status",
      arguments: {},
    };
  }

  const statusMatch = message.match(
    /^(?:is|check whether|check if|show whether|what(?:'s| is) the status of)\s+(?:my\s+)?(.+?)\s+(?:connected|set up|linked)(?:\s+yet)?[.!?]*$/i
  );

  if (statusMatch) {
    const provider = cleanIntegrationProviderQuery(statusMatch[1]);
    if (!provider || !looksLikeIntegrationProviderQuery(provider)) {
      return null;
    }

    return {
      name: "integration_status",
      arguments: { provider },
    };
  }

  const bareProviderResolution = resolveIntegrationProviderQuery(normalizedMessage);
  if (bareProviderResolution.provider) {
    return {
      name: "integration_status",
      arguments: { provider: bareProviderResolution.provider.id },
    };
  }

  const normalizedProviderOnly = cleanIntegrationProviderQuery(normalizedMessage);
  const providerOnlyResolution = resolveIntegrationProviderQuery(
    normalizedProviderOnly
  );
  if (providerOnlyResolution.provider) {
    return {
      name: "integration_status",
      arguments: { provider: providerOnlyResolution.provider.id },
    };
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

function parseWorkspaceToolCall(message: string): ToolCall | null {
  // "what do you know about me" → read user profile
  if (
    /\bwhat do you know about me\b/i.test(message) ||
    /\byour? (?:notes|file|profile) (?:on|about) me\b/i.test(message)
  ) {
    return { name: "workspace_read", arguments: { path: "USER.md" } };
  }

  // "check your context" / "what are you working on"
  if (
    /\byour? (?:current )?context\b/i.test(message) ||
    /\bwhat are you (?:working on|focused on|tracking)\b/i.test(message)
  ) {
    return { name: "workspace_read", arguments: { path: "CONTEXT.md" } };
  }

  // "check your workspace" / "list your files"
  if (
    /\byour? (?:workspace|files|home)\b/i.test(message) ||
    /\bwhat'?s in (?:your )?workspace\b/i.test(message)
  ) {
    return { name: "workspace_list", arguments: { directory: "" } };
  }

  // "write that down" / "note that" / "jot this down" / "remember this about me"
  // These need LLM planning since the content must be extracted — let the planner handle it
  // by returning null and letting shouldAttemptToolUse trigger the planner

  return null;
}

function parseCalendarReadToolCall(message: string): ToolCall | null {
  const normalizedMessage = normalizeDirectToolMessage(message);

  if (
    /\bwhat'?s on my calendar\b/i.test(normalizedMessage) ||
    /\bcheck my calendar\b/i.test(normalizedMessage) ||
    /\bshow my calendar\b/i.test(normalizedMessage) ||
    /\bmy schedule\b/i.test(normalizedMessage) ||
    /\bupcoming events\b/i.test(normalizedMessage) ||
    /\bfree time\b/i.test(normalizedMessage) ||
    /\bavailability\b/i.test(normalizedMessage) ||
    /\bam i free\b/i.test(normalizedMessage) ||
    /\b(?:do i have|check if i have|what do i have|am i free|am i available)\b.*\b(?:meeting|meetings|event|events|appointment|appointments|calendar)\b/i.test(
      normalizedMessage
    ) ||
    /\b(?:do i have|what do i have|am i free|am i available)\b.*\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/i.test(
      normalizedMessage
    )
  ) {
    const range = extractCalendarRange(normalizedMessage);
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

function inferIntegrationQueryFromHistory(
  recentMessages: ChatMessage[],
  activeThread?: ActiveOperationalThread | null
): string | null {
  if (activeThread?.kind === "integration" && activeThread.providerId) {
    return activeThread.providerId;
  }

  const candidates = [...recentMessages]
    .reverse()
    .map((message) => message.content.trim());

  for (const content of candidates) {
    const directResolution = resolveIntegrationProviderQuery(content);
    if (directResolution.provider) {
      return directResolution.provider.id;
    }

    const match = content.match(
      /(?:connect|link|set up|disconnect|check if)\s+(?:my\s+)?(.+?)(?:\s+(?:connected|set up|linked))?[.!?]*$/i
    );

    if (match?.[1]) {
      const cleaned = cleanIntegrationProviderQuery(match[1]);
      if (cleaned && looksLikeIntegrationProviderQuery(cleaned)) {
        return cleaned;
      }
    }
  }

  return null;
}

function isActiveIntegrationConversation(
  recentMessages: ChatMessage[],
  activeThread?: ActiveOperationalThread | null
): boolean {
  if (activeThread?.kind === "integration") {
    return true;
  }

  const candidates = [...recentMessages].reverse().slice(0, 8);

  return candidates.some((message) =>
    /\b(connect|connection|oauth|auth|sign-?in|linked|integration)\b/i.test(
      message.content
    )
  );
}

function normalizeDirectToolMessage(message: string): string {
  let normalized = message.trim();

  const prefixes = [
    /^(?:bro|hey nicole|hey|yo|nicole)\b[,.:;!\s]*/i,
    /^(?:let'?s|lets)\s+(?:just\s+)?/i,
    /^(?:okay|ok|alright|right|cool|so|well|please)\b[,.:;!\s]*/i,
    /^(?:yes|yeah|yep|yup|sure)\b[,.:;!\s]*/i,
  ];

  for (let i = 0; i < 3; i += 1) {
    let changed = false;
    for (const prefix of prefixes) {
      const next = normalized.replace(prefix, "").trim();
      if (next && next !== normalized) {
        normalized = next;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return normalized;
}

function looksLikeIntegrationConnectFollowUp(message: string): boolean {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (/^(?:yes|yeah|yep|yup|sure|okay|ok|alright|do it|go ahead|please do)[.!?]*$/i.test(normalized)) {
    return true;
  }

  return [
    /^(?:yes|yeah|yep|yup|sure|okay|ok|alright|do it|go ahead|please do)\b.*\b(?:initiate|start|launch|open|oauth|auth|connection|connect|flow|setup|set up|sign-?in)\b/i,
    /\b(?:initiate|start|launch|open)\b.*\b(?:oauth|auth|connection|connect|flow|setup|set up|sign-?in)\b/i,
    /\b(?:set up|setup)\b.*\b(?:oauth|auth|flow|connection|connect|sign-?in)\b/i,
    /\b(?:open|launch)\b.*\b(?:the )?(?:oauth|auth|sign-?in|connection) (?:flow|page)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function cleanSearchQuery(value: string): string {
  return value
    .replace(/\s+and\s+tell\s+me\s+what\s+you\s+find.*$/i, "")
    .replace(/\s+and\s+let\s+me\s+know.*$/i, "")
    .replace(/\s+for\s+me.*$/i, "")
    .replace(/\s+is$/i, "")
    .replace(/[?.!]+$/g, "")
    .replace(/^who\s+/i, "")
    .replace(/^what\s+/i, "")
    .trim();
}

function cleanIntegrationProviderQuery(value: string): string {
  return normalizeIntegrationProviderQuery(
    value
    .replace(/\b(?:account|integration|provider|service)\b/gi, "")
    .replace(/\b(?:connected|set up|linked)\b/gi, "")
    .replace(/\bto\s+(?:you|nicole)\b/gi, "")
    .replace(/[?.!]+$/g, "")
  );
}

function looksLikeIntegrationProviderQuery(value: string): boolean {
  return Boolean(resolveIntegrationProviderQuery(value).provider) ||
    /\b(calendar|gcal|google|zoho|mail|email|gmail|reminder|reminders|apple)\b/i.test(
      value
    );
}

function inferEmailProviderHint(value: string): "gmail" | "zoho_mail" | null {
  const normalized = value.toLowerCase();

  if (/\bgmail\b|\bgoogle mail\b|\bgoogle email\b/i.test(normalized)) {
    return "gmail";
  }

  if (/\bzoho\b|\bzoho mail\b|\bzoho email\b/i.test(normalized)) {
    return "zoho_mail";
  }

  return null;
}

function extractEmailSelection(value: string): string | null {
  const lowered = value.toLowerCase();

  if (/\b(first|1st)\b/.test(lowered)) return "first";
  if (/\b(second|2nd)\b/.test(lowered)) return "second";
  if (/\b(third|3rd)\b/.test(lowered)) return "third";
  if (/\b(fourth|4th)\b/.test(lowered)) return "fourth";
  if (/\b(fifth|5th)\b/.test(lowered)) return "fifth";
  if (/\b(last|latest|newest|most recent)\b/.test(lowered)) return "last";
  if (/\b(that|it|that one|this one)\b/.test(lowered)) return "that";

  return null;
}

function extractEmailSenderHint(value: string): string | null {
  const senderPatterns = [
    /\b(?:from|to)\s+([a-z][a-z]+(?:\s+[a-z][a-z]+){0,2})\b/i,
    /\b(?:from|to)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
    /\bwhat(?:\s+else)?\s+did\s+([a-z][a-z]+(?:\s+[a-z][a-z]+){0,2})\s+say\b/i,
    /\bwhat\s+did\s+([a-z][a-z]+(?:\s+[a-z][a-z]+){0,2})\s+say\b/i,
    /\btell me more about\s+([a-z][a-z]+(?:\s+[a-z][a-z]+){0,2})(?:'s)?\s+(?:email|mail|message)\b/i,
    /\b([a-z][a-z]+(?:\s+[a-z][a-z]+){0,2})(?:'s)?\s+(?:email|mail|message)\b/i,
  ];

  const senderMatch = senderPatterns
    .map((pattern) => value.match(pattern))
    .find((match) => Boolean(match?.[1]));

  if (!senderMatch?.[1]) {
    return null;
  }

  return senderMatch[1].trim();
}

function extractReplyInstructions(value: string): string | null {
  const sayingMatch = value.match(/\bsaying\s+(.+)$/i);
  if (sayingMatch?.[1]) {
    return sayingMatch[1].trim().replace(/[.!?]+$/g, "");
  }

  const thatSaysMatch = value.match(/\bthat says\s+(.+)$/i);
  if (thatSaysMatch?.[1]) {
    return thatSaysMatch[1].trim().replace(/[.!?]+$/g, "");
  }

  return null;
}

function normalizeEmailProviderHint(
  value: string | null
): "gmail" | "zoho_mail" | null {
  if (!value) {
    return null;
  }

  return inferEmailProviderHint(value);
}

function extractEmailTimeWindow(value: string): {
  since: Date | null;
  until: Date | null;
} | null {
  const now = new Date();
  const lastDaysMatch = value.match(/\b(?:past|last)\s+(\d+)\s+days?\b/i);
  if (lastDaysMatch) {
    const days = Number(lastDaysMatch[1]);
    if (!Number.isNaN(days) && days > 0) {
      const since = new Date(now);
      since.setDate(since.getDate() - days);
      return { since, until: null };
    }
  }

  const lastWeeksMatch = value.match(/\b(?:past|last)\s+(\d+)\s+weeks?\b/i);
  if (lastWeeksMatch) {
    const weeks = Number(lastWeeksMatch[1]);
    if (!Number.isNaN(weeks) && weeks > 0) {
      const since = new Date(now);
      since.setDate(since.getDate() - weeks * 7);
      return { since, until: null };
    }
  }

  if (/\btoday\b/i.test(value)) {
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    return { since, until: null };
  }

  if (/\byesterday\b/i.test(value)) {
    const since = new Date(now);
    since.setDate(since.getDate() - 1);
    since.setHours(0, 0, 0, 0);
    const until = new Date(since);
    until.setDate(until.getDate() + 1);
    return { since, until };
  }

  return null;
}

function buildEmailSearchQuery(options: {
  provider: "gmail" | "zoho_mail" | null;
  explicitQuery: string | null;
  timeWindow: { since: Date | null; until: Date | null } | null;
}): string | null {
  const normalizedQuery = options.explicitQuery?.trim() || "";

  if (options.provider === "gmail") {
    const parts: string[] = [];
    if (normalizedQuery) {
      parts.push(normalizedQuery);
    }
    if (options.timeWindow?.since) {
      parts.push(`after:${formatGmailQueryDate(options.timeWindow.since)}`);
    }
    if (options.timeWindow?.until) {
      parts.push(`before:${formatGmailQueryDate(options.timeWindow.until)}`);
    }
    return parts.join(" ").trim() || "in:anywhere";
  }

  if (options.provider === "zoho_mail") {
    const parts: string[] = [];
    const dateFilters: string[] = [];
    if (options.timeWindow?.since) {
      dateFilters.push(`fromDate:${formatZohoQueryDate(options.timeWindow.since)}`);
    }
    if (options.timeWindow?.until) {
      dateFilters.push(`toDate:${formatZohoQueryDate(options.timeWindow.until)}`);
    }
    if (dateFilters.length > 0) {
      parts.push(dateFilters.join("::"));
    }
    if (normalizedQuery) {
      parts.push(normalizedQuery);
    }
    return parts.join("::").trim() || "newMails";
  }

  return normalizedQuery || null;
}

function formatGmailQueryDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function formatZohoQueryDate(value: Date): string {
  const day = String(value.getDate()).padStart(2, "0");
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][value.getMonth()];
  const year = value.getFullYear();
  return `${day}-${month}-${year}`;
}

interface WebSearchToolOutput {
  query?: string;
  provider?: string;
  status?: "ok" | "weak" | "unavailable";
  liveSearchAvailable?: boolean;
  warning?: string | null;
  error?: string | null;
  topResultContent?: string | null;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

interface IntegrationToolOutput {
  ok?: boolean;
  action?: "status" | "connect" | "disconnect";
  provider?: {
    title?: string;
    connected?: boolean;
    configured?: boolean;
    status?: "ready" | "planned";
    account?: {
      email?: string | null;
      displayName?: string | null;
    } | null;
  } | null;
  message?: string;
  connectUrl?: string | null;
  browserOpened?: boolean;
  browserOpenError?: string | null;
  unsupportedService?: string | null;
  suggestions?: string[];
  allProviders?: Array<{
    title?: string;
    connected?: boolean;
    configured?: boolean;
    status?: "ready" | "planned";
  }>;
}

function formatEmailToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `Tool ${result.name} failed.\nError: ${result.error}`;
  }

  const output = (result.output || {}) as Record<string, any>;

  if (result.name === "email_search") {
    const provider = output.provider || "email";
    const results = Array.isArray(output.results) ? output.results : [];
    if (results.length === 0) {
      return `Tool email_search provider: ${provider}\nResults: 0\nCRITICAL: Tell Roy there were no matching emails.`;
    }

    const lines = results.map((item, index) =>
      [
        `${index + 1}. ${item.subject || "(no subject)"}`,
        item.sender || item.fromAddress
          ? `   From: ${item.sender || item.fromAddress}`
          : null,
        item.receivedAt ? `   Received: ${item.receivedAt}` : null,
        item.id ? `   Message ID: ${item.id}` : null,
        item.threadId ? `   Thread ID: ${item.threadId}` : null,
        item.summary ? `   Summary: ${item.summary}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );

    return `Tool email_search provider: ${provider}\n${lines.join(
      "\n\n"
    )}\nCRITICAL: These are real email search results. Use them instead of inventing inbox contents.`;
  }

  if (result.name === "email_read") {
    const message = output.message || {};
    return `Tool email_read provider: ${output.provider || "email"}\nSubject: ${
      message.subject || "(no subject)"
    }\nFrom: ${message.sender || message.fromAddress || "unknown"}\nTo: ${
      Array.isArray(message.toAddresses) ? message.toAddresses.join(", ") : ""
    }\nReceived: ${message.receivedAt || "unknown"}\nMessage ID: ${
      message.id || "unknown"
    }\nThread ID: ${message.threadId || "none"}\nBody:\n${
      message.bodyText || message.summary || "(no readable body)"
    }\nCRITICAL: This is the actual email content that was loaded.`;
  }

  if (result.name === "email_thread_read") {
    const messages = Array.isArray(output.messages) ? output.messages : [];
    const lines = messages.map((message, index) =>
      [
        `${index + 1}. ${message.subject || "(no subject)"}`,
        message.sender || message.fromAddress
          ? `   From: ${message.sender || message.fromAddress}`
          : null,
        message.receivedAt ? `   Received: ${message.receivedAt}` : null,
        message.bodyText
          ? `   Body: ${String(message.bodyText).slice(0, 800)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    );

    return `Tool email_thread_read provider: ${output.provider || "email"}\nThread ID: ${
      output.threadId || "unknown"
    }\nMessages:\n${lines.join("\n\n")}${
      output.note ? `\nNote: ${output.note}` : ""
    }\nCRITICAL: This is the actual email thread content that was loaded.`;
  }

  if (result.name === "email_reply_draft") {
    const draft = output.draft || {};
    const target = output.target || {};
    return `Tool email_reply_draft provider: ${output.provider || "email"}\nTarget subject: ${
      target.subject || "(no subject)"
    }\nReply to: ${draft.to || target.fromAddress || "unknown"}\nDraft subject: ${
      draft.subject || "(no subject)"
    }\nDraft body:\n${
      draft.body || "(empty draft)"
    }\nCRITICAL: This draft was generated from a real email. Present it as a draft, not as already sent.`;
  }

  if (result.name === "email_reply_send") {
    return `Tool email_reply_send provider: ${output.provider || "email"}\nStatus: ${
      output.status || "sent"
    }\nMessage ID: ${
      output.messageId || "unknown"
    }\nCRITICAL: Tell Roy the reply has been sent.`;
  }

  return `Tool ${result.name} returned:\n${JSON.stringify(result.output, null, 2)}`;
}

function formatIntegrationToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `Tool ${result.name} failed.\nError: ${result.error}`;
  }

  const output = asIntegrationToolOutput(result.output);
  if (output?.ok === false) {
    const suggestions =
      output.suggestions && output.suggestions.length > 0
        ? `\nSuggestions: ${output.suggestions.join(", ")}`
        : "";
    return `Tool ${result.name} status: blocked\nMessage: ${
      output.message || "The integration request could not be completed."
    }${suggestions}\nCRITICAL: Tell Roy exactly what is or isn't supported.`;
  }

  const providerTitle = output?.provider?.title || "integration";
  const accountLabel =
    output?.provider?.account?.email ||
    output?.provider?.account?.displayName ||
    null;

  if (result.name === "integration_connect") {
    return `Tool integration_connect status: ${
      output?.provider?.connected ? "already_connected" : "auth_started"
    }\nProvider: ${providerTitle}\nMessage: ${output?.message || "Connection flow prepared."}\nBrowser opened: ${
      output?.browserOpened ? "yes" : "no"
    }${
      output?.connectUrl ? `\nConnect URL: ${output.connectUrl}` : ""
    }${
      output?.browserOpenError ? `\nBrowser launch issue: ${output.browserOpenError}` : ""
    }\nCRITICAL: If the browser was opened, tell Roy to finish the sign-in there. If it was not opened but a connect URL exists, give him that URL plainly.`;
  }

  if (result.name === "integration_disconnect") {
    return `Tool integration_disconnect status: done\nProvider: ${providerTitle}\nMessage: ${
      output?.message || `${providerTitle} disconnected.`
    }\nCRITICAL: Tell Roy the provider is disconnected now.`;
  }

  if (Array.isArray(output?.allProviders) && output.allProviders.length > 0) {
    const lines = output.allProviders.map((provider) => {
      const state =
        provider.status === "planned"
          ? "planned"
          : provider.connected
            ? "connected"
            : provider.configured
              ? "available_not_connected"
              : "not_configured";
      return `- ${provider.title || "Unknown"}: ${state}`;
    });

    return `Tool integration_status snapshot:\n${lines.join("\n")}\nCRITICAL: Report these integration states directly.`;
  }

  return `Tool integration_status provider: ${providerTitle}\nConnected: ${
    output?.provider?.connected ? "yes" : "no"
  }\nConfigured: ${output?.provider?.configured ? "yes" : "no"}\nStatus: ${
    output?.provider?.status || "unknown"
  }${accountLabel ? `\nAccount: ${accountLabel}` : ""}\nMessage: ${
    output?.message || "No integration status message."
  }\nCRITICAL: Report this provider state directly.`;
}

function formatWeatherToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `Weather check failed: ${result.error || "Could not fetch weather data."}`;
  }

  const output = result.output as { formatted?: string };
  if (output?.formatted) {
    return `Weather data (live):\n${output.formatted}\n\nPresent this naturally. Don't list raw numbers — summarize conversationally.`;
  }

  return `Tool weather_get returned:\n${JSON.stringify(result.output, null, 2)}`;
}

function formatWebSearchToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `Tool web_search status: unavailable\nWarning: ${result.error || "Live Google search failed."}\nCRITICAL: Tell the user live Google search failed before giving any fallback answer. Do not claim you searched the web.`;
  }

  const output = asWebSearchToolOutput(result.output);
  const status = output?.status || "unavailable";
  const provider = output?.provider || "google";
  const warning = output?.warning || output?.error || null;
  const results = Array.isArray(output?.results)
    ? output.results.filter(
        (item) =>
          typeof item?.title === "string" &&
          item.title.trim().length > 0 &&
          typeof item?.url === "string" &&
          item.url.trim().length > 0
      )
    : [];

  if (status === "ok") {
    const topContent = typeof output?.topResultContent === "string" && output.topResultContent.length > 0
      ? `\n\nEnriched content from top result (${results[0]?.title || "page"}):\n${output.topResultContent}`
      : "";

    return `Tool web_search status: ok\nProvider: ${provider}\nLive search available: yes\nResults:\n${formatSearchResults(
      results.map((item) => ({
        title: item.title!.trim(),
        url: item.url!.trim(),
        content: typeof item.content === "string" ? item.content.trim() : "",
      }))
    )}${topContent}\nCRITICAL: Answer from these live results. Do not present prior knowledge as if it came from live search.`;
  }

  if (status === "weak") {
    const resultsText =
      results.length > 0
        ? `\nThin live results:\n${formatSearchResults(
            results.map((item) => ({
              title: item.title!.trim(),
              url: item.url!.trim(),
              content:
                typeof item.content === "string" ? item.content.trim() : "",
            }))
          )}`
        : "";

    return `Tool web_search status: weak\nProvider: ${provider}\nLive search available: ${
      output?.liveSearchAvailable ? "yes" : "no"
    }\nWarning: ${
      warning || "Live Google search returned thin or inconclusive results."
    }${resultsText}\nCRITICAL: Tell the user the live web results were thin or inconclusive before giving any cautious fallback answer.`;
  }

  return `Tool web_search status: unavailable\nProvider: ${provider}\nLive search available: no\nWarning: ${
    warning || "Live Google search is unavailable right now."
  }\nCRITICAL: Tell the user live Google search was unavailable before giving any fallback answer. Do not claim you searched the web.`;
}

function asWebSearchToolOutput(value: unknown): WebSearchToolOutput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as WebSearchToolOutput;
}

function asIntegrationToolOutput(value: unknown): IntegrationToolOutput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as IntegrationToolOutput;
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

function parseEmailFollowUpToolCall(message: string): ToolCall | null {
  const sender = extractEmailSenderHint(message);
  const selection = extractEmailSelection(message);
  const provider = inferEmailProviderHint(message);

  const asksForMoreFromSender =
    /\bwhat(?:\s+else)?\s+did\b/i.test(message) && /\bsay\b/i.test(message);
  const asksForMoreFromEmail =
    /\btell me more about\b/i.test(message) ||
    /\bwhat(?:'s| is| else is)\s+in\b/i.test(message);
  const wantsThread = /\b(?:thread|conversation)\b/i.test(message);

  if (!asksForMoreFromSender && !asksForMoreFromEmail) {
    return null;
  }

  if (!sender && !selection) {
    return null;
  }

  return {
    name: wantsThread ? "email_thread_read" : "email_read",
    arguments: {
      ...(sender ? { sender } : {}),
      ...(selection ? { selection } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

function parseEmailSearchToolCall(message: string): ToolCall | null {
  const provider = inferEmailProviderHint(message);
  const timeWindow = extractEmailTimeWindow(message);
  const match =
    message.match(/^(?:search|find)\s+(?:my\s+)?email(?:s)?\s+(?:for|about)\s+(.+)$/i) ||
    message.match(/^(?:search|find)\s+emails?\s+from\s+(.+)$/i);

  if (match) {
    const query = buildEmailSearchQuery({
      provider,
      explicitQuery: match[1].trim(),
      timeWindow,
    });

    if (!query) {
      return null;
    }

    return {
      name: "email_search",
      arguments: {
        query,
        ...(provider ? { provider } : {}),
      },
    };
  }

  const looksLikeNaturalEmailCheck =
    /\b(?:mail|emails?|inbox)\b/i.test(message) &&
    (/\b(?:check|scan|look(?:\s+through|\s+in)?|see|show)\b/i.test(message) ||
      /\bdo i have\b/i.test(message) ||
      /\bany emails?\b/i.test(message));

  if (!looksLikeNaturalEmailCheck) {
    return null;
  }

  const query = buildEmailSearchQuery({
    provider,
    explicitQuery: null,
    timeWindow,
  });

  if (!query) {
    return null;
  }

  return {
    name: "email_search",
    arguments: {
      query,
      ...(provider ? { provider } : {}),
    },
  };
}

function parseEmailThreadReadToolCall(message: string): ToolCall | null {
  if (!/\b(?:thread|conversation)\b/i.test(message)) {
    return null;
  }

  if (!/\b(?:read|open|show|pull up|load|check)\b/i.test(message)) {
    return null;
  }

  const selection = extractEmailSelection(message);
  const sender = extractEmailSenderHint(message);
  const provider = inferEmailProviderHint(message);

  return {
    name: "email_thread_read",
    arguments: {
      ...(selection ? { selection } : {}),
      ...(sender ? { sender } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

function parseEmailReadToolCall(message: string): ToolCall | null {
  if (!/\b(?:read|open|show|pull up|load|check)\b/i.test(message)) {
    return null;
  }

  if (
    !/\b(?:email|mail|message|one|it|that|latest|last|first|second|third|fourth|fifth)\b/i.test(
      message
    )
  ) {
    return null;
  }

  if (/\b(?:thread|conversation)\b/i.test(message)) {
    return null;
  }

  const selection = extractEmailSelection(message);
  const sender = extractEmailSenderHint(message);
  const provider = inferEmailProviderHint(message);

  if (!selection && !sender && !/\b(?:email|mail|message)\b/i.test(message)) {
    return null;
  }

  return {
    name: "email_read",
    arguments: {
      ...(selection ? { selection } : {}),
      ...(sender ? { sender } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

function parseEmailReplyDraftToolCall(message: string): ToolCall | null {
  if (!/\b(?:draft|write|compose|prepare)\b/i.test(message)) {
    return null;
  }

  if (!/\breply\b/i.test(message)) {
    return null;
  }

  const selection = extractEmailSelection(message);
  const sender = extractEmailSenderHint(message);
  const provider = inferEmailProviderHint(message);
  const instructions = extractReplyInstructions(message);

  return {
    name: "email_reply_draft",
    arguments: {
      ...(selection ? { selection } : {}),
      ...(sender ? { sender } : {}),
      ...(provider ? { provider } : {}),
      ...(instructions ? { instructions } : {}),
    },
  };
}

function parseEmailReplySendToolCall(message: string): ToolCall | null {
  const isExplicitSend =
    /\b(?:send|ship)\b/i.test(message) && /\breply\b/i.test(message);
  const isSendPronoun =
    /^(?:please\s+)?send\s+(?:it|that|the reply|this reply)[.!?]*$/i.test(
      message
    );
  const isDirectReply =
    /^(?:please\s+)?reply\s+to\b/i.test(message) && /\bsaying\b/i.test(message);

  if (!isExplicitSend && !isSendPronoun && !isDirectReply) {
    return null;
  }

  const selection = extractEmailSelection(message);
  const sender = extractEmailSenderHint(message);
  const provider = inferEmailProviderHint(message);
  const instructions = extractReplyInstructions(message);

  return {
    name: "email_reply_send",
    arguments: {
      ...(selection ? { selection } : {}),
      ...(sender ? { sender } : {}),
      ...(provider ? { provider } : {}),
      ...(instructions ? { body: instructions } : {}),
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

interface EmailReference {
  provider: "gmail" | "zoho_mail";
  id: string;
  threadId: string | null;
  folderId: string | null;
  subject: string | null;
  fromAddress: string | null;
  sender: string | null;
}

interface EmailMessageContext extends EmailReference {
  receivedAt: string | null;
  bodyText: string | null;
  summary: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  messageIdHeader: string | null;
  references: string | null;
}

async function resolveEmailReference(
  input: Record<string, unknown>
): Promise<EmailReference | null> {
  const providerHint = normalizeEmailProviderHint(
    readOptionalString(input, "provider")
  );
  const explicitMessageId = readOptionalString(input, "messageId");
  const selection = readOptionalString(input, "selection");
  const senderHint = readOptionalString(input, "sender");

  const lastRead = await getLatestSuccessfulEmailToolOutput(
    "email_read",
    providerHint
  );
  const lastReadMessage = asEmailReadOutput(lastRead?.output)?.message || null;

  if (explicitMessageId) {
    if (lastReadMessage?.id === explicitMessageId) {
      return emailReferenceFromMessage(lastReadMessage, providerHint || lastRead?.provider || null);
    }

    const lastSearch = await getLatestSuccessfulEmailToolOutput(
      "email_search",
      providerHint
    );
    const searchOutput = asEmailSearchOutput(lastSearch?.output);
    const results = Array.isArray(searchOutput?.results) ? searchOutput.results : [];
    const exact = results.find((item) => item.id === explicitMessageId);
    if (exact) {
      return emailReferenceFromResult(exact, providerHint || lastSearch?.provider || null);
    }
  }

  if (selection && /^(that|it|this|that one)$/i.test(selection) && lastReadMessage) {
    return emailReferenceFromMessage(
      lastReadMessage,
      providerHint || lastRead?.provider || null
    );
  }

  const lastSearch = await getLatestSuccessfulEmailToolOutput(
    "email_search",
    providerHint
  );
  const searchOutput = asEmailSearchOutput(lastSearch?.output);
  const results = Array.isArray(searchOutput?.results) ? searchOutput.results : [];
  const candidateProvider = providerHint || lastSearch?.provider || lastRead?.provider || null;

  if (senderHint && results.length > 0) {
    const match = results.find((item) =>
      `${item.sender || ""} ${item.fromAddress || ""}`
        .toLowerCase()
        .includes(senderHint.toLowerCase())
    );
    if (match) {
      return emailReferenceFromResult(match, candidateProvider);
    }
  }

  const selectionIndex = selectionToIndex(selection);
  if (selectionIndex !== null && results[selectionIndex]) {
    return emailReferenceFromResult(results[selectionIndex], candidateProvider);
  }

  if (selection && selection.toLowerCase() === "last" && results.length > 0) {
    return emailReferenceFromResult(results[results.length - 1], candidateProvider);
  }

  if (results.length === 1) {
    return emailReferenceFromResult(results[0], candidateProvider);
  }

  if (!selection && !senderHint && lastReadMessage) {
    return emailReferenceFromMessage(
      lastReadMessage,
      candidateProvider
    );
  }

  return null;
}

async function loadEmailMessageForReference(
  reference: EmailReference
): Promise<EmailMessageContext | null> {
  if (reference.provider === "gmail") {
    const message = await readGmailMessage({ messageId: reference.id });
    if (!message) {
      return null;
    }

    return {
      provider: "gmail",
      id: message.id,
      threadId: message.threadId || null,
      folderId: null,
      subject: message.subject,
      fromAddress: message.fromAddress,
      sender: message.sender,
      receivedAt: message.receivedAt,
      bodyText: message.bodyText,
      summary: message.summary,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      messageIdHeader: message.messageIdHeader,
      references: message.references,
    };
  }

  const message = await readZohoMailMessage({
    messageId: reference.id,
    folderId: reference.folderId,
  });
  if (!message) {
    return null;
  }

  return {
    provider: "zoho_mail",
    id: message.id,
    threadId: message.threadId || null,
    folderId: message.folderId || null,
    subject: message.subject,
    fromAddress: message.fromAddress,
    sender: message.sender,
    receivedAt: message.receivedAt,
    bodyText: message.bodyText,
    summary: message.summary,
    toAddresses: message.toAddresses,
    ccAddresses: message.ccAddresses,
    messageIdHeader: message.messageIdHeader,
    references: message.references,
  };
}

async function draftReplyFromEmail(
  message: EmailMessageContext,
  instructions: string
) {
  const response = await chat(
    [
      {
        role: "system",
        content:
          "You draft concise, professional email replies. Return only compact JSON with keys subject and body. No markdown, no code fences, no explanation.",
      },
      {
        role: "user",
        content: [
          `Original subject: ${message.subject || "(no subject)"}`,
          `From: ${message.sender || message.fromAddress || "unknown"}`,
          `Received: ${message.receivedAt || "unknown"}`,
          `Original body: ${(message.bodyText || message.summary || "").slice(0, 4000)}`,
          `Instructions: ${instructions}`,
        ].join("\n"),
      },
    ],
    {
      temperature: 0.2,
      maxTokens: 500,
    }
  );

  const text = typeof response === "string" ? response.trim() : "";
  const parsed = parseDraftReplyJson(text);
  if (parsed) {
    return parsed;
  }

  return {
    subject: ensureReplySubjectLine(message.subject || "(no subject)"),
    body: text || "Thanks. I'll get back to you shortly.",
  };
}

async function getLatestSuccessfulEmailToolOutput(
  toolName: string,
  providerHint: "gmail" | "zoho_mail" | null
) {
  const rows = await db
    .select({
      toolName: toolInvocations.toolName,
      output: toolInvocations.output,
      createdAt: toolInvocations.createdAt,
    })
    .from(toolInvocations)
    .where(eq(toolInvocations.status, "success"))
    .orderBy(desc(toolInvocations.createdAt))
    .limit(20);

  for (const row of rows) {
    if (row.toolName !== toolName) {
      continue;
    }

    const provider = extractEmailProviderFromOutput(row.output);
    if (providerHint && provider && provider !== providerHint) {
      continue;
    }

    return {
      ...row,
      provider,
    };
  }

  return null;
}

async function getLatestEmailReplyDraftOutput(
  providerHint: "gmail" | "zoho_mail" | null
) {
  const row = await getLatestSuccessfulEmailToolOutput(
    "email_reply_draft",
    providerHint
  );

  return asEmailReplyDraftOutput(row?.output);
}

function extractEmailProviderFromOutput(output: unknown): "gmail" | "zoho_mail" | null {
  if (!output || typeof output !== "object") {
    return null;
  }

  const provider = (output as Record<string, unknown>).provider;
  return provider === "gmail" || provider === "zoho_mail" ? provider : null;
}

function selectionToIndex(value: string | null): number | null {
  if (!value) {
    return null;
  }

  switch (value.toLowerCase()) {
    case "first":
      return 0;
    case "second":
      return 1;
    case "third":
      return 2;
    case "fourth":
      return 3;
    case "fifth":
      return 4;
    default:
      return null;
  }
}

function emailReferenceFromResult(
  result: Record<string, any>,
  provider: "gmail" | "zoho_mail" | null
): EmailReference | null {
  if (!provider || typeof result.id !== "string") {
    return null;
  }

  return {
    provider,
    id: result.id,
    threadId: typeof result.threadId === "string" ? result.threadId : null,
    folderId: typeof result.folderId === "string" ? result.folderId : null,
    subject: typeof result.subject === "string" ? result.subject : null,
    fromAddress:
      typeof result.fromAddress === "string" ? result.fromAddress : null,
    sender: typeof result.sender === "string" ? result.sender : null,
  };
}

function emailReferenceFromMessage(
  message: Record<string, any>,
  provider: "gmail" | "zoho_mail" | null
): EmailReference | null {
  if (!provider || typeof message.id !== "string") {
    return null;
  }

  return {
    provider,
    id: message.id,
    threadId: typeof message.threadId === "string" ? message.threadId : null,
    folderId: typeof message.folderId === "string" ? message.folderId : null,
    subject: typeof message.subject === "string" ? message.subject : null,
    fromAddress:
      typeof message.fromAddress === "string" ? message.fromAddress : null,
    sender: typeof message.sender === "string" ? message.sender : null,
  };
}

function asEmailSearchOutput(output: unknown):
  | { provider?: string; results?: Record<string, any>[] }
  | null {
  return output && typeof output === "object"
    ? (output as { provider?: string; results?: Record<string, any>[] })
    : null;
}

function asEmailReadOutput(output: unknown):
  | { provider?: string; message?: Record<string, any> }
  | null {
  return output && typeof output === "object"
    ? (output as { provider?: string; message?: Record<string, any> })
    : null;
}

function asEmailReplyDraftOutput(output: unknown):
  | {
      provider?: "gmail" | "zoho_mail";
      draft?: {
        to?: string | null;
        subject?: string | null;
        body?: string | null;
        cc?: string | null;
        originalMessageId?: string | null;
        threadId?: string | null;
        messageIdHeader?: string | null;
        references?: string | null;
      };
    }
  | null {
  return output && typeof output === "object"
    ? (output as {
        provider?: "gmail" | "zoho_mail";
        draft?: {
          to?: string | null;
          subject?: string | null;
          body?: string | null;
          cc?: string | null;
          originalMessageId?: string | null;
          threadId?: string | null;
          messageIdHeader?: string | null;
          references?: string | null;
        };
      })
    : null;
}

function parseDraftReplyJson(value: string) {
  const jsonMatch = value.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      subject?: unknown;
      body?: unknown;
    };
    if (
      typeof parsed.subject === "string" &&
      parsed.subject.trim().length > 0 &&
      typeof parsed.body === "string" &&
      parsed.body.trim().length > 0
    ) {
      return {
        subject: parsed.subject.trim(),
        body: parsed.body.trim(),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function ensureReplySubjectLine(value: string) {
  return /^re:/i.test(value.trim()) ? value.trim() : `Re: ${value.trim()}`;
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

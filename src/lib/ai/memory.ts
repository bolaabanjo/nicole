import { db } from "@/lib/db/client";
import {
  memories,
  chatMessages,
  conversationSummaries,
  toolInvocations,
} from "@/lib/db/schema";
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lte,
} from "drizzle-orm";
import { chat, embed, isBackgroundAIEnabled, isEmbeddingAvailable } from "./router";
import { ChatMessage } from "./types";
import type { ChatMessageRecord } from "./topic-state";

const MEMORY_EXTRACT_PROMPT = `You are Nicole's memory system. Given a conversation between Nicole and Roy, extract any new facts worth remembering long-term.

Rules:
- Only extract things Roy explicitly said or clearly implied about himself, his preferences, goals, feelings, or plans.
- Don't extract generic knowledge or things Nicole said.
- Don't extract things that are only relevant to this exact moment.
- Each memory should be a single, clear sentence.
- If the memory is clearly about a specific person, project, or topic, include a short "topic" field. Otherwise omit it or use null.
- Categorize each as: personal, preference, goal, fact, or context.
- Rate importance 1-10 (10 = core identity, 1 = trivial detail).
- If there's nothing worth remembering, return an empty array.

Return ONLY valid JSON array, no markdown:
[{"content": "...", "category": "...", "importance": 5, "topic": "..." }]`;

const CONVERSATION_SUMMARY_PROMPT = `You are Nicole's long-term conversation summarizer. Compress the conversation window into a short memory-friendly summary.

Focus on:
- durable facts or updates about Roy
- ongoing projects, priorities, and decisions
- unresolved questions Nicole should remember
- emotional tone or friction only if it matters later

Rules:
- write 1-3 short paragraphs, not bullet points
- keep names, places, and project terms concrete
- do not mention "the user" or "the assistant"
- do not include chain-of-thought or step-by-step reasoning
- do not repeat trivial greetings or filler`;

const MEMORY_RESOLUTION_PROMPT = `You decide how Nicole should store a new memory.

Choose one action:
- "insert" when the new memory is genuinely distinct
- "ignore" when the new memory repeats an existing memory with no meaningful improvement
- "merge" when the new memory updates, corrects, or better canonicalizes an existing memory

Merge examples:
- "Roy lives in London" + new memory "Roy moved to Lagos" => merge, canonical memory becomes "Roy lives in Lagos."
- "Roy is building Nicole" + new memory "Roy is building Nicole, a personal intelligence network" => merge into the richer canonical memory

Rules:
- Only merge if both memories refer to the same underlying fact, preference, project, or person
- Do not collapse two related-but-distinct facts into one
- Keep merged content as a single clear sentence
- Preserve the strongest category and topic
- Return JSON only, no markdown

Allowed outputs:
{"action":"insert"}
{"action":"ignore","targetId":"..."}
{"action":"merge","targetId":"...","content":"...","category":"...","importance":7,"topic":"..."}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_FULL_CONTEXT_DAYS = 7;
const RECENT_MESSAGE_WINDOW = 80;
const SUMMARY_BATCH_SIZE = 12;
const MIN_MESSAGES_TO_SUMMARIZE = 8;
const SUMMARY_CONTEXT_LIMIT = 4;
const MEMORY_CONTEXT_LIMIT = 8;
const MEMORY_CORE_LIMIT = 3;
const MEMORY_CANDIDATE_LIMIT = 6;
const MEMORY_DEDUP_DISTANCE_THRESHOLD = 0.32;
const MEMORY_RELEVANCE_THRESHOLD = 0.4;
const TOOL_ACTIVITY_CONTEXT_LIMIT = 4;
const TOOL_ACTIVITY_CANDIDATE_LIMIT = 16;
const SUMMARY_RELEVANCE_CANDIDATE_LIMIT = 12;

const CONTEXT_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "been",
  "before",
  "between",
  "could",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "need",
  "past",
  "please",
  "said",
  "same",
  "that",
  "them",
  "there",
  "these",
  "they",
  "thing",
  "this",
  "those",
  "want",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
  "zoho",
  "gmail",
  "email",
  "mail",
  "inbox",
  "nicole",
  "roy",
]);

interface MemoryInput {
  content: string;
  category: string;
  importance?: number;
  source?: string;
  topic?: string;
}

interface MemoryCandidate {
  id: string;
  content: string;
  category: string;
  importance: number | null;
  source: string | null;
  topic: string | null;
  score: number | null;
}

type MemoryResolution =
  | { action: "insert" }
  | { action: "ignore"; targetId: string }
  | {
      action: "merge";
      targetId: string;
      content: string;
      category?: string;
      importance?: number;
      topic?: string | null;
    };

export interface MemorySearchResult {
  id?: string;
  content: string;
  category: string;
  source: string | null;
  topic: string | null;
  importance?: number | null;
  score?: number | null;
}

/**
 * Store a memory and generate an embedding when possible.
 */
export async function storeMemory(memory: MemoryInput): Promise<void> {
  try {
    const normalizedMemory = normalizeMemoryInput(memory);
    if (!normalizedMemory) return;

    let embedding: number[] | null = null;

    try {
      embedding = await embed(normalizedMemory.content);
    } catch (error) {
      console.error("Memory embedding failed:", error);
    }

    const candidates = await loadMemoryCandidates(normalizedMemory, embedding);
    const exactCandidate = candidates.find(
      (candidate) =>
        normalizeMemoryText(candidate.content) ===
        normalizeMemoryText(normalizedMemory.content)
    );

    if (exactCandidate) {
      await touchMemory(exactCandidate, normalizedMemory);
      return;
    }

    const closeCandidates = candidates.filter(
      (candidate) =>
        candidate.score === null ||
        candidate.score <= MEMORY_DEDUP_DISTANCE_THRESHOLD
    );

    if (closeCandidates.length > 0) {
      const resolution = await resolveMemoryStorage(
        normalizedMemory,
        closeCandidates
      );

      if (resolution.action === "ignore") {
        const target = closeCandidates.find(
          (candidate) => candidate.id === resolution.targetId
        );
        if (target) {
          await touchMemory(target, normalizedMemory);
          return;
        }
      }

      if (resolution.action === "merge") {
        const target = closeCandidates.find(
          (candidate) => candidate.id === resolution.targetId
        );
        if (target) {
          await mergeMemory(target, normalizedMemory, resolution, embedding);
          return;
        }
      }
    }

    await insertMemory(normalizedMemory, embedding);
  } catch (error) {
    console.error("Failed to store memory:", error);
  }
}

/**
 * Extract memories from a conversation and store them.
 */
export async function extractAndStoreMemories(
  messages: ChatMessage[]
): Promise<void> {
  if (messages.length < 2) return;
  if (!isBackgroundAIEnabled()) return;

  try {
    const conversationText = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const response = await chat([
      { role: "system", content: MEMORY_EXTRACT_PROMPT },
      { role: "user", content: conversationText },
    ]);

    const text = typeof response === "string" ? response : String(response);
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const extracted = JSON.parse(cleaned);

    if (Array.isArray(extracted) && extracted.length > 0) {
      const highImportance: string[] = [];

      for (const mem of extracted) {
        if (mem.content && mem.category) {
          await storeMemory({
            content: mem.content,
            category: mem.category,
            importance: mem.importance || 5,
            source: "conversation",
            topic:
              typeof mem.topic === "string" && mem.topic.trim()
                ? mem.topic.trim()
                : undefined,
          });

          // Also log high-importance memories to the daily workspace file
          if ((mem.importance || 5) >= 7) {
            highImportance.push(mem.content);
          }
        }
      }

      // Write notable memories to ~/.nicole/memory/YYYY-MM-DD.md
      if (highImportance.length > 0) {
        try {
          const { appendToDailyMemory } = await import("./workspace");
          for (const entry of highImportance) {
            await appendToDailyMemory(entry);
          }
        } catch {
          // Workspace write is best-effort
        }
      }
    }
  } catch (error) {
    console.error("Memory extraction failed:", error);
  }
}

/**
 * Load Nicole's memories. If a query is provided, prefer semantically relevant memories.
 */
export async function loadMemories(
  queryOrLimit?: string | number,
  maybeLimit = MEMORY_CONTEXT_LIMIT
): Promise<string> {
  const query =
    typeof queryOrLimit === "string" ? queryOrLimit.trim() : undefined;
  const limit =
    typeof queryOrLimit === "number" ? queryOrLimit : maybeLimit;

  try {
    const mems =
      query && query.length > 0
        ? await loadContextMemories(query, limit)
        : await loadCoreMemories(limit);

    if (mems.length === 0) return "";

    touchReferencedMemories(
      mems
        .map((memory) => memory.id)
        .filter((id): id is string => Boolean(id))
    ).catch(() => {});

    return mems
      .map((m) => {
        const topicTag = m.topic ? ` (re: ${m.topic})` : "";
        const sourceTag = m.source === "research" ? " [researched]" : "";
        return `[${m.category}]${sourceTag}${topicTag} ${m.content}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

export async function searchRelevantMemories(
  query: string,
  limit = 8
): Promise<MemorySearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const mems = await loadRelevantMemories(trimmed, limit);

    touchReferencedMemories(
      mems
        .map((memory) => ("id" in memory ? memory.id : undefined))
        .filter((id): id is string => Boolean(id))
    ).catch(() => {});

    return mems.map((memory) => ({
      id: "id" in memory ? memory.id : undefined,
      content: memory.content,
      category: memory.category,
      source: memory.source ?? null,
      topic: memory.topic ?? null,
      importance: "importance" in memory ? memory.importance : null,
      score:
        "score" in memory && typeof memory.score === "number"
          ? memory.score
          : null,
    }));
  } catch (error) {
    console.error("Memory search tool failed:", error);
    return [];
  }
}

/**
 * Load recent conversation summaries so Nicole keeps long-range context
 * without dragging the full transcript into every prompt.
 */
export async function loadConversationSummaryContext(
  queryOrLimit?: string | number,
  maybeLimit = SUMMARY_CONTEXT_LIMIT
): Promise<string> {
  const query =
    typeof queryOrLimit === "string" ? queryOrLimit.trim() : undefined;
  const limit =
    typeof queryOrLimit === "number" ? queryOrLimit : maybeLimit;

  try {
    const summaries = await db
      .select({
        id: conversationSummaries.id,
        summary: conversationSummaries.summary,
        startCreatedAt: conversationSummaries.startCreatedAt,
        endCreatedAt: conversationSummaries.endCreatedAt,
        messageCount: conversationSummaries.messageCount,
        createdAt: conversationSummaries.createdAt,
      })
      .from(conversationSummaries)
      .orderBy(desc(conversationSummaries.endCreatedAt), desc(conversationSummaries.createdAt))
      .limit(SUMMARY_RELEVANCE_CANDIDATE_LIMIT);

    if (summaries.length === 0) return "";

    const ranked = rankSummaryContext(summaries, query).slice(0, limit);

    if (ranked.length === 0) {
      return "";
    }

    return ranked
      .reverse()
      .map((entry) => {
        const dateRange = formatSummaryDateRange(
          entry.startCreatedAt,
          entry.endCreatedAt
        );
        const countTag =
          entry.messageCount > 0 ? ` (${entry.messageCount} messages)` : "";
        return `[Summary${dateRange ? ` ${dateRange}` : ""}${countTag}] ${entry.summary}`;
      })
      .join("\n\n");
  } catch (error) {
    console.error("Failed to load conversation summaries:", error);
    return "";
  }
}

/**
 * Summarize older unsummarized messages in the background. This keeps
 * Nicole's long-term context compact while preserving recent turn-by-turn chat.
 */
export async function summarizeOldConversations(): Promise<void> {
  if (!isBackgroundAIEnabled()) {
    return;
  }

  try {
    const recentContextCutoff = new Date(
      Date.now() - RECENT_FULL_CONTEXT_DAYS * DAY_MS
    );

    const lastSummary = await db
      .select({
        endCreatedAt: conversationSummaries.endCreatedAt,
      })
      .from(conversationSummaries)
      .orderBy(desc(conversationSummaries.endCreatedAt), desc(conversationSummaries.createdAt))
      .limit(1);

    const summaryCutoff = lastSummary[0]?.endCreatedAt ?? null;

    const olderMessagesWhere = summaryCutoff
      ? and(
          lte(chatMessages.createdAt, recentContextCutoff),
          gt(chatMessages.createdAt, summaryCutoff)
        )
      : lte(chatMessages.createdAt, recentContextCutoff);

    const olderMessages = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(olderMessagesWhere)
      .orderBy(asc(chatMessages.createdAt))
      .limit(SUMMARY_BATCH_SIZE);

    if (olderMessages.length < MIN_MESSAGES_TO_SUMMARIZE) {
      return;
    }

    const conversationText = olderMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const response = await chat([
      { role: "system", content: CONVERSATION_SUMMARY_PROMPT },
      { role: "user", content: conversationText },
    ]);

    const summary =
      typeof response === "string" ? response.trim() : String(response).trim();

    if (!summary) {
      return;
    }

    await db.insert(conversationSummaries).values({
      startMessageId: olderMessages[0]?.id ?? null,
      endMessageId: olderMessages[olderMessages.length - 1]?.id ?? null,
      startCreatedAt: olderMessages[0]?.createdAt ?? null,
      endCreatedAt:
        olderMessages[olderMessages.length - 1]?.createdAt ?? null,
      messageCount: olderMessages.length,
      summary,
    });
  } catch (error) {
    console.error("Conversation summarization failed:", error);
  }
}

async function loadRelevantMemories(query: string, limit: number) {
  if (!isEmbeddingAvailable()) {
    return loadKeywordMatchedMemories(query, limit);
  }

  try {
    const queryEmbedding = await embed(query);
    const distance = cosineDistance(memories.embedding, queryEmbedding);

    const mems = await db
      .select({
        id: memories.id,
        content: memories.content,
        category: memories.category,
        source: memories.source,
        topic: memories.topic,
        importance: memories.importance,
        score: distance,
      })
      .from(memories)
      .where(isNotNull(memories.embedding))
      .orderBy(
        distance,
        desc(memories.importance),
        desc(memories.lastReferencedAt),
        desc(memories.createdAt)
      )
      .limit(Math.max(limit * 4, 12));

    const filtered = mems.filter(
      (memory) =>
        typeof memory.score === "number" &&
        (memory.score <= MEMORY_RELEVANCE_THRESHOLD ||
          memoryMatchesQuery(memory, query))
    );

    if (filtered.length > 0) {
      return filtered.slice(0, limit);
    }
  } catch (error) {
    console.error("Semantic memory retrieval failed:", error);
  }

  return loadKeywordMatchedMemories(query, limit);
}

async function loadTopMemories(limit: number) {
  return db
    .select({
      id: memories.id,
      content: memories.content,
      category: memories.category,
      source: memories.source,
      topic: memories.topic,
      importance: memories.importance,
    })
    .from(memories)
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(limit);
}

/**
 * Save a single message to the chat history.
 */
export async function saveChatMessage(
  role: "user" | "assistant",
  content: string
): Promise<ChatMessageRecord | null> {
  try {
    const inserted = await db
      .insert(chatMessages)
      .values({ role, content })
      .returning({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      });

    return inserted[0] as ChatMessageRecord | null;
  } catch (error) {
    console.error("Failed to save chat message:", error);
    return null;
  }
}

/**
 * Load recent chat messages for context (sent to the AI).
 */
export async function loadRecentMessages(limit = 20): Promise<ChatMessage[]> {
  const records = await loadRecentMessageRecords(limit);
  return records.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export async function loadRecentMessageRecords(
  limit = 20
): Promise<ChatMessageRecord[]> {
  try {
    const recentCutoff = new Date(Date.now() - RECENT_FULL_CONTEXT_DAYS * DAY_MS);

    const msgs = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(gte(chatMessages.createdAt, recentCutoff))
      .orderBy(desc(chatMessages.createdAt))
      .limit(Math.max(limit, RECENT_MESSAGE_WINDOW));

    // Reverse so they're in chronological order
    return msgs.reverse() as ChatMessageRecord[];
  } catch {
    return [];
  }
}

export function trimPendingUserMessage(
  messages: ChatMessage[],
  pendingUserMessage: string
): ChatMessage[] {
  const trimmed = pendingUserMessage.trim();
  if (!trimmed || messages.length === 0) {
    return messages;
  }

  const last = messages[messages.length - 1];
  if (
    last?.role === "user" &&
    typeof last.content === "string" &&
    last.content.trim() === trimmed
  ) {
    return messages.slice(0, -1);
  }

  return messages;
}

export async function loadRecentToolActivityContext(
  queryOrLimit?: string | number,
  maybeLimit = TOOL_ACTIVITY_CONTEXT_LIMIT
): Promise<string> {
  const query =
    typeof queryOrLimit === "string" ? queryOrLimit.trim() : undefined;
  const limit =
    typeof queryOrLimit === "number" ? queryOrLimit : maybeLimit;

  try {
    const recentCutoff = new Date(Date.now() - RECENT_FULL_CONTEXT_DAYS * DAY_MS);
    const rows = await db
      .select({
        toolName: toolInvocations.toolName,
        input: toolInvocations.input,
        output: toolInvocations.output,
        createdAt: toolInvocations.createdAt,
      })
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.status, "success"),
          gte(toolInvocations.createdAt, recentCutoff)
        )
      )
      .orderBy(desc(toolInvocations.createdAt))
      .limit(TOOL_ACTIVITY_CANDIDATE_LIMIT);

    if (rows.length === 0) {
      return "";
    }

    const ranked = rankToolActivity(rows, query).slice(0, limit);
    if (ranked.length === 0) {
      return "";
    }

    return ranked
      .reverse()
      .map((row) => formatToolActivityLine(row))
      .join("\n");
  } catch (error) {
    console.error("Failed to load recent tool activity:", error);
    return "";
  }
}

function formatSummaryDateRange(
  start: Date | null,
  end: Date | null
): string {
  if (!start && !end) return "";

  const startLabel = start ? formatSummaryDate(start) : "";
  const endLabel = end ? formatSummaryDate(end) : "";

  if (startLabel && endLabel && startLabel !== endLabel) {
    return `${startLabel} -> ${endLabel}`;
  }

  return startLabel || endLabel;
}

function formatSummaryDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function loadCoreMemories(limit: number) {
  return db
    .select({
      id: memories.id,
      content: memories.content,
      category: memories.category,
      source: memories.source,
      topic: memories.topic,
      importance: memories.importance,
    })
    .from(memories)
    .where(gte(memories.importance, 8))
    .orderBy(
      desc(memories.importance),
      desc(memories.lastReferencedAt),
      desc(memories.createdAt)
    )
    .limit(limit);
}

async function loadContextMemories(query: string, limit: number) {
  const [core, relevant] = await Promise.all([
    loadCoreMemories(MEMORY_CORE_LIMIT),
    loadRelevantMemories(query, Math.max(limit - MEMORY_CORE_LIMIT, 4)),
  ]);

  const seen = new Set<string>();
  return [...core, ...relevant].filter((memory) => {
    if (!memory.id || seen.has(memory.id)) {
      return false;
    }

    seen.add(memory.id);
    return true;
  }).slice(0, limit);
}

async function loadKeywordMatchedMemories(query: string, limit: number) {
  const terms = extractSalientTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const candidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      category: memories.category,
      source: memories.source,
      topic: memories.topic,
      importance: memories.importance,
    })
    .from(memories)
    .orderBy(
      desc(memories.lastReferencedAt),
      desc(memories.importance),
      desc(memories.createdAt)
    )
    .limit(100);

  return candidates
    .map((memory) => ({
      ...memory,
      keywordScore: scoreQueryAgainstText(
        query,
        `${memory.topic || ""}\n${memory.content}\n${memory.category}`
      ),
    }))
    .filter((memory) => memory.keywordScore > 0)
    .sort((a, b) => {
      if (b.keywordScore !== a.keywordScore) {
        return b.keywordScore - a.keywordScore;
      }
      return (b.importance || 0) - (a.importance || 0);
    })
    .slice(0, limit)
    .map(({ keywordScore: _keywordScore, ...memory }) => memory);
}

function extractSalientTerms(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
  const unique: string[] = [];

  for (const token of tokens) {
    if (CONTEXT_STOPWORDS.has(token)) {
      continue;
    }
    if (!unique.includes(token)) {
      unique.push(token);
    }
  }

  return unique.slice(0, 10);
}

function scoreQueryAgainstText(query: string | undefined, text: string): number {
  if (!query) {
    return 0;
  }

  const terms = extractSalientTerms(query);
  if (terms.length === 0) {
    return 0;
  }

  const haystack = text.toLowerCase();
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0
  );
}

function memoryMatchesQuery(
  memory: { topic: string | null; content: string; category: string },
  query: string
): boolean {
  return (
    scoreQueryAgainstText(
      query,
      `${memory.topic || ""}\n${memory.content}\n${memory.category}`
    ) > 0
  );
}

function rankSummaryContext<
  T extends {
    summary: string;
    startCreatedAt: Date | null;
    endCreatedAt: Date | null;
    messageCount: number;
    createdAt: Date | null;
  },
>(summaries: T[], query?: string) {
  if (!query?.trim()) {
    return summaries.slice(0, SUMMARY_CONTEXT_LIMIT);
  }

  return summaries
    .map((entry) => ({
      entry,
      score: scoreQueryAgainstText(query, entry.summary),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        (b.entry.endCreatedAt?.getTime() || b.entry.createdAt?.getTime() || 0) -
        (a.entry.endCreatedAt?.getTime() || a.entry.createdAt?.getTime() || 0)
      );
    })
    .map((item) => item.entry);
}

function rankToolActivity<
  T extends {
    toolName: string;
    input: unknown;
    output: unknown;
    createdAt: Date | null;
  },
>(rows: T[], query?: string) {
  if (!query?.trim()) {
    return rows.slice(0, TOOL_ACTIVITY_CONTEXT_LIMIT);
  }

  const ranked = rows
    .map((row) => ({
      row,
      score: scoreQueryAgainstText(
        query,
        `${row.toolName}\n${JSON.stringify(row.input) || ""}\n${
          JSON.stringify(row.output) || ""
        }`
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.row.createdAt?.getTime() || 0) - (a.row.createdAt?.getTime() || 0);
    })
    .map((item) => item.row);

  return ranked;
}

function formatToolActivityLine(row: {
  toolName: string;
  input: unknown;
  output: unknown;
  createdAt: Date | null;
}): string {
  const timestamp = row.createdAt
    ? row.createdAt.toISOString().replace("T", " ").slice(0, 16)
    : "recently";
  const output =
    row.output && typeof row.output === "object"
      ? (row.output as Record<string, unknown>)
      : null;

  if (row.toolName === "email_search") {
    const provider = typeof output?.provider === "string" ? output.provider : "email";
    const results = Array.isArray(output?.results) ? output.results : [];
    const first =
      results[0] && typeof results[0] === "object"
        ? (results[0] as Record<string, unknown>)
        : null;
    const sender =
      typeof first?.sender === "string"
        ? first.sender
        : typeof first?.fromAddress === "string"
          ? first.fromAddress
          : null;
    return `- ${timestamp}: used ${provider} email search and found ${results.length} message${
      results.length === 1 ? "" : "s"
    }${sender ? `, including one from ${sender}` : ""}.`;
  }

  if (row.toolName === "email_read") {
    const message =
      output?.message && typeof output.message === "object"
        ? (output.message as Record<string, unknown>)
        : null;
    const subject =
      typeof message?.subject === "string" ? message.subject : "an email";
    const sender =
      typeof message?.sender === "string"
        ? message.sender
        : typeof message?.fromAddress === "string"
          ? message.fromAddress
          : "someone";
    return `- ${timestamp}: read "${subject}" from ${sender}.`;
  }

  if (row.toolName === "email_thread_read") {
    const count =
      typeof output?.messageCount === "number" ? output.messageCount : null;
    return `- ${timestamp}: opened an email thread${
      count ? ` with ${count} messages` : ""
    }.`;
  }

  if (row.toolName === "integration_connect") {
    const provider =
      output?.provider && typeof output.provider === "object"
        ? (output.provider as Record<string, unknown>)
        : null;
    const title =
      typeof provider?.title === "string" ? provider.title : "an integration";
    return `- ${timestamp}: connected ${title}.`;
  }

  if (row.toolName === "calendar_read") {
    return `- ${timestamp}: checked the calendar.`;
  }

  if (row.toolName === "web_search") {
    const results = Array.isArray(output?.results) ? output.results : [];
    return `- ${timestamp}: ran a web search and got ${results.length} result${
      results.length === 1 ? "" : "s"
    }.`;
  }

  return `- ${timestamp}: used ${row.toolName}.`;
}

async function touchReferencedMemories(ids: string[]) {
  if (ids.length === 0) {
    return;
  }

  const uniqueIds = Array.from(new Set(ids));
  await Promise.all(
    uniqueIds.map((id) =>
      db
        .update(memories)
        .set({ lastReferencedAt: new Date() })
        .where(eq(memories.id, id))
    )
  );
}

function normalizeMemoryInput(memory: MemoryInput): MemoryInput | null {
  const content = memory.content.trim();
  const category = memory.category.trim();

  if (!content || !category) {
    return null;
  }

  return {
    content,
    category,
    importance: memory.importance || 5,
    source: memory.source || "conversation",
    topic:
      typeof memory.topic === "string" && memory.topic.trim()
        ? memory.topic.trim()
        : undefined,
  };
}

function normalizeMemoryText(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

async function insertMemory(
  memory: MemoryInput,
  embedding: number[] | null
): Promise<void> {
  await db.insert(memories).values({
    content: memory.content,
    category: memory.category,
    importance: memory.importance || 5,
    source: memory.source || "conversation",
    topic: memory.topic || null,
    embedding,
  });
}

async function loadMemoryCandidates(
  memory: MemoryInput,
  embedding: number[] | null
): Promise<MemoryCandidate[]> {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();

  const pushUnique = (rows: MemoryCandidate[]) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      candidates.push(row);
    }
  };

  if (embedding) {
    const distance = cosineDistance(memories.embedding, embedding);
    const semanticRows = await db
      .select({
        id: memories.id,
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        source: memories.source,
        topic: memories.topic,
        score: distance,
      })
      .from(memories)
      .where(isNotNull(memories.embedding))
      .orderBy(distance, desc(memories.importance), desc(memories.lastReferencedAt))
      .limit(MEMORY_CANDIDATE_LIMIT);

    pushUnique(
      semanticRows.map((row) => ({
        ...row,
        score: typeof row.score === "number" ? row.score : Number(row.score),
      }))
    );
  }

  if (memory.topic) {
    const topicRows = await db
      .select({
        id: memories.id,
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        source: memories.source,
        topic: memories.topic,
        score: memories.importance,
      })
      .from(memories)
      .where(eq(memories.topic, memory.topic))
      .orderBy(desc(memories.lastReferencedAt), desc(memories.createdAt))
      .limit(MEMORY_CANDIDATE_LIMIT);

    pushUnique(
      topicRows.map((row) => ({
        ...row,
        score: null,
      }))
    );
  }

  if (candidates.length === 0) {
    const fallbackRows = await db
      .select({
        id: memories.id,
        content: memories.content,
        category: memories.category,
        importance: memories.importance,
        source: memories.source,
        topic: memories.topic,
        score: memories.importance,
      })
      .from(memories)
      .orderBy(desc(memories.lastReferencedAt), desc(memories.createdAt))
      .limit(MEMORY_CANDIDATE_LIMIT);

    pushUnique(
      fallbackRows.map((row) => ({
        ...row,
        score: null,
      }))
    );
  }

  return candidates;
}

async function resolveMemoryStorage(
  memory: MemoryInput,
  candidates: MemoryCandidate[]
): Promise<MemoryResolution> {
  try {
    const response = await chat([
      { role: "system", content: MEMORY_RESOLUTION_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          {
            newMemory: memory,
            candidates: candidates.map((candidate) => ({
              id: candidate.id,
              content: candidate.content,
              category: candidate.category,
              importance: candidate.importance,
              source: candidate.source,
              topic: candidate.topic,
              score: candidate.score,
            })),
          },
          null,
          2
        ),
      },
    ]);

    const text = typeof response === "string" ? response : String(response);
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<MemoryResolution>;

    if (parsed.action === "insert") {
      return { action: "insert" };
    }

    if (
      parsed.action === "ignore" &&
      typeof parsed.targetId === "string" &&
      parsed.targetId.length > 0
    ) {
      return { action: "ignore", targetId: parsed.targetId };
    }

    if (
      parsed.action === "merge" &&
      typeof parsed.targetId === "string" &&
      parsed.targetId.length > 0 &&
      typeof parsed.content === "string" &&
      parsed.content.trim().length > 0
    ) {
      return {
        action: "merge",
        targetId: parsed.targetId,
        content: parsed.content.trim(),
        category:
          typeof parsed.category === "string" && parsed.category.trim()
            ? parsed.category.trim()
            : undefined,
        importance:
          typeof parsed.importance === "number"
            ? parsed.importance
            : undefined,
        topic:
          typeof parsed.topic === "string"
            ? parsed.topic.trim() || null
            : parsed.topic === null
              ? null
              : undefined,
      };
    }
  } catch (error) {
    console.error("Memory resolution failed:", error);
  }

  return { action: "insert" };
}

async function touchMemory(
  candidate: MemoryCandidate,
  memory: MemoryInput
): Promise<void> {
  await db
    .update(memories)
    .set({
      importance: Math.max(candidate.importance || 5, memory.importance || 5),
      topic: candidate.topic || memory.topic || null,
      source: candidate.source || memory.source || "conversation",
      lastReferencedAt: new Date(),
    })
    .where(eq(memories.id, candidate.id));
}

async function mergeMemory(
  candidate: MemoryCandidate,
  memory: MemoryInput,
  resolution: Extract<MemoryResolution, { action: "merge" }>,
  fallbackEmbedding: number[] | null
): Promise<void> {
  let mergedEmbedding = fallbackEmbedding;

  if (resolution.content !== memory.content) {
    try {
      mergedEmbedding = await embed(resolution.content);
    } catch (error) {
      console.error("Merged memory embedding failed:", error);
    }
  }

  await db
    .update(memories)
    .set({
      content: resolution.content,
      category: resolution.category || candidate.category,
      importance: Math.max(
        candidate.importance || 5,
        resolution.importance || memory.importance || 5
      ),
      source: memory.source || candidate.source || "conversation",
      topic:
        resolution.topic !== undefined
          ? resolution.topic
          : memory.topic || candidate.topic || null,
      embedding: mergedEmbedding,
      lastReferencedAt: new Date(),
    })
    .where(eq(memories.id, candidate.id));
}

/**
 * Load all chat messages for display, with timestamps for date separators.
 */
export async function loadAllMessages(): Promise<
  { id: string; role: string; content: string; createdAt: Date | null }[]
> {
  try {
    return await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .orderBy(asc(chatMessages.createdAt));
  } catch {
    return [];
  }
}

import { db } from "@/lib/db/client";
import {
  memories,
  chatMessages,
  conversationSummaries,
} from "@/lib/db/schema";
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  isNotNull,
  lte,
} from "drizzle-orm";
import { chat, embed, isBackgroundAIEnabled, isEmbeddingAvailable } from "./router";
import { ChatMessage } from "./types";

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

const RECENT_MESSAGE_WINDOW = 20;
const SUMMARY_BATCH_SIZE = 12;
const MIN_MESSAGES_TO_SUMMARIZE = 8;
const SUMMARY_CONTEXT_LIMIT = 4;
const MEMORY_CANDIDATE_LIMIT = 6;
const MEMORY_DEDUP_DISTANCE_THRESHOLD = 0.32;

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
  maybeLimit = 30
): Promise<string> {
  const query =
    typeof queryOrLimit === "string" ? queryOrLimit.trim() : undefined;
  const limit =
    typeof queryOrLimit === "number" ? queryOrLimit : maybeLimit;

  try {
    const mems =
      query && query.length > 0
        ? await loadRelevantMemories(query, limit)
        : await loadTopMemories(limit);

    if (mems.length === 0) return "";

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
  limit = SUMMARY_CONTEXT_LIMIT
): Promise<string> {
  try {
    const summaries = await db
      .select({
        summary: conversationSummaries.summary,
        startCreatedAt: conversationSummaries.startCreatedAt,
        endCreatedAt: conversationSummaries.endCreatedAt,
        messageCount: conversationSummaries.messageCount,
      })
      .from(conversationSummaries)
      .orderBy(desc(conversationSummaries.endCreatedAt), desc(conversationSummaries.createdAt))
      .limit(limit);

    if (summaries.length === 0) return "";

    return summaries
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
    const recentMessages = await db
      .select({
        id: chatMessages.id,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .orderBy(desc(chatMessages.createdAt))
      .limit(RECENT_MESSAGE_WINDOW);

    if (recentMessages.length < MIN_MESSAGES_TO_SUMMARIZE) {
      return;
    }

    const oldestRecentMessage =
      recentMessages[recentMessages.length - 1]?.createdAt ?? null;

    if (!oldestRecentMessage) {
      return;
    }

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
          lte(chatMessages.createdAt, oldestRecentMessage),
          gt(chatMessages.createdAt, summaryCutoff)
        )
      : lte(chatMessages.createdAt, oldestRecentMessage);

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
    return loadTopMemories(limit);
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
      .limit(limit);

    if (mems.length > 0) {
      return mems;
    }
  } catch (error) {
    console.error("Semantic memory retrieval failed:", error);
  }

  return loadTopMemories(limit);
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
): Promise<void> {
  try {
    await db.insert(chatMessages).values({ role, content });
  } catch (error) {
    console.error("Failed to save chat message:", error);
  }
}

/**
 * Load recent chat messages for context (sent to the AI).
 */
export async function loadRecentMessages(limit = 20): Promise<ChatMessage[]> {
  try {
    const latestSummary = await db
      .select({
        endCreatedAt: conversationSummaries.endCreatedAt,
      })
      .from(conversationSummaries)
      .orderBy(desc(conversationSummaries.endCreatedAt), desc(conversationSummaries.createdAt))
      .limit(1);

    const summaryCutoff = latestSummary[0]?.endCreatedAt ?? null;

    const msgs = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(summaryCutoff ? gt(chatMessages.createdAt, summaryCutoff) : undefined)
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    // Reverse so they're in chronological order
    return msgs.reverse() as ChatMessage[];
  } catch {
    return [];
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

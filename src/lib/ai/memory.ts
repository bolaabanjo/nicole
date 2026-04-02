import { db } from "@/lib/db/client";
import { memories, chatMessages } from "@/lib/db/schema";
import { asc, cosineDistance, desc, isNotNull } from "drizzle-orm";
import { chat, embed } from "./router";
import { ChatMessage } from "./types";

const MEMORY_EXTRACT_PROMPT = `You are Nicole's memory system. Given a conversation between Nicole and Roy, extract any new facts worth remembering long-term.

Rules:
- Only extract things Roy explicitly said or clearly implied about himself, his preferences, goals, feelings, or plans.
- Don't extract generic knowledge or things Nicole said.
- Don't extract things that are only relevant to this exact moment.
- Each memory should be a single, clear sentence.
- Categorize each as: personal, preference, goal, fact, or context.
- Rate importance 1-10 (10 = core identity, 1 = trivial detail).
- If there's nothing worth remembering, return an empty array.

Return ONLY valid JSON array, no markdown:
[{"content": "...", "category": "...", "importance": 5}]`;

interface MemoryInput {
  content: string;
  category: string;
  importance?: number;
  source?: string;
  topic?: string;
}

/**
 * Store a memory and generate an embedding when possible.
 */
export async function storeMemory(memory: MemoryInput): Promise<void> {
  try {
    let embedding: number[] | null = null;

    try {
      embedding = await embed(memory.content);
    } catch (error) {
      console.error("Memory embedding failed:", error);
    }

    await db.insert(memories).values({
      content: memory.content,
      category: memory.category,
      importance: memory.importance || 5,
      source: memory.source || "conversation",
      topic: memory.topic || null,
      embedding,
    });
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
      for (const mem of extracted) {
        if (mem.content && mem.category) {
          await storeMemory({
            content: mem.content,
            category: mem.category,
            importance: mem.importance || 5,
            source: "conversation",
          });
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

async function loadRelevantMemories(query: string, limit: number) {
  try {
    const queryEmbedding = await embed(query);
    const distance = cosineDistance(memories.embedding, queryEmbedding);

    const mems = await db
      .select({
        content: memories.content,
        category: memories.category,
        source: memories.source,
        topic: memories.topic,
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
      content: memories.content,
      category: memories.category,
      source: memories.source,
      topic: memories.topic,
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
    const msgs = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    // Reverse so they're in chronological order
    return msgs.reverse() as ChatMessage[];
  } catch {
    return [];
  }
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

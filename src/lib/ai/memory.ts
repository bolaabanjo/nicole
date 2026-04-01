import { db } from "@/lib/db/client";
import { memories, conversations } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { chat } from "./router";
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

    // Parse the JSON response
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const extracted = JSON.parse(cleaned);

    if (Array.isArray(extracted) && extracted.length > 0) {
      for (const mem of extracted) {
        if (mem.content && mem.category) {
          await db.insert(memories).values({
            content: mem.content,
            category: mem.category,
            importance: mem.importance || 5,
          });
        }
      }
    }
  } catch (error) {
    console.error("Memory extraction failed:", error);
    // Non-critical — conversation still works without new memories
  }
}

/**
 * Load Nicole's memories, most important and recent first.
 */
export async function loadMemories(limit = 30): Promise<string> {
  try {
    const mems = await db
      .select({
        content: memories.content,
        category: memories.category,
      })
      .from(memories)
      .orderBy(desc(memories.importance), desc(memories.createdAt))
      .limit(limit);

    if (mems.length === 0) return "";

    return mems
      .map((m) => `[${m.category}] ${m.content}`)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Save a conversation to the database.
 */
export async function saveConversation(
  messages: ChatMessage[]
): Promise<string | null> {
  try {
    const [conv] = await db
      .insert(conversations)
      .values({ messages: JSON.stringify(messages) })
      .returning();
    return conv.id;
  } catch (error) {
    console.error("Failed to save conversation:", error);
    return null;
  }
}

/**
 * Load recent conversation history for context.
 */
export async function loadRecentConversations(limit = 3): Promise<string> {
  try {
    const recent = await db
      .select({
        messages: conversations.messages,
        summary: conversations.summary,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .orderBy(desc(conversations.createdAt))
      .limit(limit);

    if (recent.length === 0) return "";

    return recent
      .map((c) => {
        if (c.summary) return `[Previous conversation] ${c.summary}`;
        const msgs = typeof c.messages === "string"
          ? JSON.parse(c.messages)
          : c.messages;
        if (!Array.isArray(msgs)) return "";
        // Just grab the last few messages as context
        const tail = msgs.slice(-4);
        return tail
          .map((m: any) => `${m.role}: ${m.content}`)
          .join("\n");
      })
      .filter(Boolean)
      .join("\n---\n");
  } catch {
    return "";
  }
}

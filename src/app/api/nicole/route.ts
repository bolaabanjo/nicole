import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import { ChatMessage } from "@/lib/ai/types";
import {
  loadMemories,
  loadRecentMessages,
  saveChatMessage,
  extractAndStoreMemories,
} from "@/lib/ai/memory";
import { searchWeb, formatSearchResults } from "@/lib/search/web";

const SEARCH_INTENT_PROMPT = `Determine if this message requires a web search to answer properly. Return ONLY a JSON object:
- If search needed: {"search": true, "query": "optimized search query"}
- If no search needed: {"search": false}

Messages that need search: current events, recent news, "look up", "search for", "what's the latest", facts you're unsure about, anything time-sensitive.
Messages that don't need search: personal conversation, opinions, things from memory, study/source material questions, greetings.`;

export async function POST(req: NextRequest) {
  try {
    const { message }: { message: string } = await req.json();

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // Save the user's message immediately
    await saveChatMessage("user", message);

    // Load context in parallel
    const [memoryText, recentMessages, sourceContext] = await Promise.all([
      loadMemories(),
      loadRecentMessages(),
      loadSourceContext(),
    ]);

    // Check if Nicole needs to search the web
    let searchContext = "";
    try {
      const intentResponse = await chat([
        { role: "system", content: SEARCH_INTENT_PROMPT },
        { role: "user", content: message },
      ]);

      const intentText =
        typeof intentResponse === "string"
          ? intentResponse
          : String(intentResponse);
      const cleaned = intentText
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      const intent = JSON.parse(cleaned);

      if (intent.search && intent.query) {
        const results = await searchWeb(intent.query);
        searchContext = formatSearchResults(results);
      }
    } catch {
      // Search intent detection failed — not critical, continue without search
    }

    const systemPrompt = buildSystemPrompt({
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
    });

    // Build full prompt with search results if any
    let fullSystemPrompt = systemPrompt;
    if (searchContext) {
      fullSystemPrompt += `\n\n## Web search results\nYou searched the web for the user's question. Use these results naturally — don't list them as bullet points, weave the information into your response. Cite sources briefly if relevant.\n\n${searchContext}`;
    }

    const fullMessages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
    ];

    const response = await chat(fullMessages);

    const content =
      typeof response === "string" ? response : String(response);

    // Save Nicole's response
    await saveChatMessage("assistant", content);

    // Extract memories in the background
    const lastExchange: ChatMessage[] = [
      { role: "user", content: message },
      { role: "assistant", content },
    ];
    extractAndStoreMemories(lastExchange).catch(() => {});

    return NextResponse.json({ content });
  } catch (error) {
    console.error("Nicole error:", error);
    return NextResponse.json(
      {
        error:
          "I can't reach my brain right now. Are you connected to the internet?",
      },
      { status: 503 }
    );
  }
}

async function loadSourceContext(): Promise<string> {
  try {
    const recentChunks = await db
      .select({
        content: chunks.content,
        title: sources.title,
      })
      .from(chunks)
      .leftJoin(sources, eq(chunks.sourceId, sources.id))
      .orderBy(asc(chunks.position))
      .limit(50);

    if (recentChunks.length > 0) {
      return recentChunks
        .map((c) => `[${c.title || "Unknown"}]\n${c.content}`)
        .join("\n\n---\n\n");
    }
  } catch {}
  return "";
}

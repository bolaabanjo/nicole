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

    const systemPrompt = buildSystemPrompt({
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
    });

    // Use recent chat history as conversation context
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentMessages,
    ];

    const response = await chat(fullMessages);

    const content =
      typeof response === "string" ? response : String(response);

    // Save Nicole's response
    await saveChatMessage("assistant", content);

    // Extract memories in the background from the last exchange
    const lastExchange: ChatMessage[] = [
      { role: "user", content: message },
      { role: "assistant", content },
    ];
    extractAndStoreMemories(lastExchange).catch(() => {});

    return NextResponse.json({ content });
  } catch (error) {
    console.error("Nicole error:", error);
    return NextResponse.json(
      { error: "I can't reach my brain right now. Are you connected to the internet?" },
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

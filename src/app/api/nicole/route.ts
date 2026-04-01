import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import { ChatMessage } from "@/lib/ai/types";
import {
  loadMemories,
  loadRecentConversations,
  saveConversation,
  extractAndStoreMemories,
} from "@/lib/ai/memory";

export async function POST(req: NextRequest) {
  try {
    const { messages }: { messages: ChatMessage[] } = await req.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages are required" },
        { status: 400 }
      );
    }

    // Load memories, recent conversations, and source context in parallel
    const [memoryText, recentText, sourceContext] = await Promise.all([
      loadMemories(),
      loadRecentConversations(),
      loadSourceContext(),
    ]);

    const systemPrompt = buildSystemPrompt({
      memories: memoryText || undefined,
      recentConversations: recentText || undefined,
      sourceContext: sourceContext || undefined,
    });

    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const response = await chat(fullMessages);

    const content =
      typeof response === "string" ? response : String(response);

    // Save conversation and extract memories in the background
    const allMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content },
    ];

    saveConversation(allMessages).catch(() => {});
    extractAndStoreMemories(allMessages).catch(() => {});

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

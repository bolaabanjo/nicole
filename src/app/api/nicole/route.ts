import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import { ChatMessage } from "@/lib/ai/types";

export async function POST(req: NextRequest) {
  try {
    const { messages }: { messages: ChatMessage[] } = await req.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages are required" },
        { status: 400 }
      );
    }

    // Fetch recent chunks with source titles for context
    let sourceContext: string | undefined;

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
        sourceContext = recentChunks
          .map((c) => `[${c.title || "Unknown"}]\n${c.content}`)
          .join("\n\n---\n\n");
      }
    } catch {
      // DB might not have data yet
    }

    const systemPrompt = buildSystemPrompt(sourceContext);

    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const response = await chat(fullMessages);

    return NextResponse.json({ content: response });
  } catch (error) {
    console.error("Nicole error:", error);
    return NextResponse.json(
      { error: "I can't reach my brain right now. Are you connected to the internet?" },
      { status: 503 }
    );
  }
}

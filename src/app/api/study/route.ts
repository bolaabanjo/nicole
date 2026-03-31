import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sources, chunks } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { chat } from "@/lib/ai/router";
import { SYSTEM_PROMPTS } from "@/lib/ai/prompts";
import { ChatMessage } from "@/lib/ai/types";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      mode,
      sourceId,
      messages,
    }: {
      mode: "socratic" | "feynman" | "review";
      sourceId: string;
      messages: ChatMessage[];
    } = body;

    if (!mode || !sourceId || !messages) {
      return NextResponse.json(
        { error: "mode, sourceId, and messages are required" },
        { status: 400 }
      );
    }

    // Fetch source and its chunks for context
    const source = await db.query.sources.findFirst({
      where: eq(sources.id, sourceId),
    });

    if (!source) {
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404 }
      );
    }

    const sourceChunks = await db.query.chunks.findMany({
      where: eq(chunks.sourceId, sourceId),
      orderBy: [asc(chunks.position)],
    });

    // Build context from chunks
    const context = sourceChunks
      .map((c, i) => `[Chunk ${i + 1}]\n${c.content}`)
      .join("\n\n---\n\n");

    // Build system prompt with source context
    const systemPrompt = `${SYSTEM_PROMPTS[mode === "review" ? "socratic" : mode]}

--- SOURCE MATERIAL ---
Title: ${source.title}
Type: ${source.type}

${context}
--- END SOURCE MATERIAL ---`;

    // Prepend system message to conversation
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    // Stream the response
    const response = await chat(fullMessages, { stream: true });

    if (response instanceof ReadableStream) {
      return new Response(response, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return NextResponse.json({ content: response });
  } catch (error) {
    console.error("Study error:", error);
    return NextResponse.json(
      { error: "Nicole is offline. Check your internet connection." },
      { status: 503 }
    );
  }
}

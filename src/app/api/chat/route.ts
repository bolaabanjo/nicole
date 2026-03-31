import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/lib/ai/router";
import { ChatMessage } from "@/lib/ai/types";

export async function POST(req: NextRequest) {
  try {
    const { messages, stream } = (await req.json()) as {
      messages: ChatMessage[];
      stream?: boolean;
    };

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages are required" },
        { status: 400 }
      );
    }

    const response = await chat(messages, { stream });

    if (stream && response instanceof ReadableStream) {
      return new Response(response, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return NextResponse.json({ content: response });
  } catch (error) {
    console.error("Chat error:", error);
    return NextResponse.json(
      { error: "Nicole is offline. Check your internet connection." },
      { status: 503 }
    );
  }
}

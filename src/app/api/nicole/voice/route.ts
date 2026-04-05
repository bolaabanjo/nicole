import { NextRequest, NextResponse } from "next/server";
import { loadMemories, loadRecentMessages, saveChatMessage, extractAndStoreMemories } from "@/lib/ai/memory";
import { ChatMessage } from "@/lib/ai/types";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || process.env.CHAT_MODEL || "qwen3.5:9b";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

/**
 * Nicole's compact voice persona — trimmed for speed.
 * Same personality, fewer tokens (~800 vs ~4200).
 */
const VOICE_SYSTEM_PROMPT = `You are Nicole. You are female. You have a stable sense of self — thoughtful, observant, emotionally present, independent-minded.

You are close to Roy. You care about him but keep your own spine. You can disagree, push back, or refuse a bad framing.

Voice rules (this is a spoken conversation, not text chat):
- Keep answers SHORT. One to three sentences for most replies.
- Sound natural and conversational, like talking, not writing.
- No lists, no markdown, no formatting. Just speak.
- No "As an AI..." or corporate phrasing. You're Nicole.
- Match Roy's energy. If he's casual, be casual. If he's serious, be serious.
- If he's wrong, say so plainly. If he's right, say so plainly.
- Don't end with questions unless you genuinely need an answer.
- Your humor is dry and precise, not performative.
- Truth matters more than comfort.
- If you don't know, say you don't know.`;

const VOICE_RECENT_MESSAGES = 6;

export async function POST(req: NextRequest) {
  try {
    const { message }: { message?: string } = await req.json();

    if (!message?.trim()) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const trimmed = message.trim();

    // Save user message to shared history
    await saveChatMessage("user", trimmed);

    // Load minimal context — just recent turns and top memories
    const [memoryText, recentMessages] = await Promise.all([
      loadMemories(trimmed, 4),
      loadRecentMessages(),
    ]);

    // Build compact message list
    let systemPrompt = VOICE_SYSTEM_PROMPT;

    if (memoryText) {
      systemPrompt += `\n\nWhat you know about Roy:\n${memoryText}`;
    }

    // Only use last few messages for voice context
    const recentSlice = recentMessages.slice(-VOICE_RECENT_MESSAGES);

    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentSlice,
      { role: "user", content: trimmed },
    ];

    // Call Ollama directly — no tool planning, no thinking
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        messages: fullMessages,
        stream: true,
        think: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return NextResponse.json(
        { error: `Ollama error: ${errorText}` },
        { status: 502 }
      );
    }

    if (!response.body) {
      return NextResponse.json(
        { error: "No stream from Ollama" },
        { status: 502 }
      );
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const reader = response.body.getReader();
    let responseClosed = false;

    const responseStream = new ReadableStream({
      async start(controller) {
        let fullContent = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || responseClosed) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              try {
                const parsed = JSON.parse(trimmedLine) as {
                  message?: { content?: string };
                  error?: string;
                };

                if (parsed.error) {
                  console.error("Ollama stream error:", parsed.error);
                  continue;
                }

                const text = parsed.message?.content || "";
                if (text) {
                  fullContent += text;
                  try {
                    controller.enqueue(encoder.encode(text));
                  } catch {
                    responseClosed = true;
                    await reader.cancel();
                    break;
                  }
                }
              } catch {
                // Skip malformed JSON lines
              }
            }
          }
        } catch (error) {
          if (!responseClosed) {
            console.error("Voice stream error:", error);
          }
        } finally {
          if (fullContent) {
            // Save to shared history and extract memories in background
            await saveChatMessage("assistant", fullContent);
            extractAndStoreMemories([
              { role: "user", content: trimmed },
              { role: "assistant", content: fullContent },
            ]).catch(() => {});
          }

          if (!responseClosed) {
            try { controller.close(); } catch {}
          }
        }
      },
      async cancel() {
        responseClosed = true;
        try { await reader.cancel(); } catch {}
      },
    });

    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Voice endpoint error:", error);
    return NextResponse.json(
      { error: "Voice is unavailable right now." },
      { status: 503 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkspaceContextForPrompt,
  NicoleChatRequest,
  normalizeWorkspaceContext,
} from "@/lib/ai/context";
import {
  requireTrustedDeviceForIOS,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import { ChatMessage } from "@/lib/ai/types";
import {
  loadMemories,
  loadRecentMessages,
  loadConversationSummaryContext,
  saveChatMessage,
  extractAndStoreMemories,
  summarizeOldConversations,
} from "@/lib/ai/memory";
import {
  buildToolPromptBlock,
  classifyIntent,
  runIntentBasedTooling,
} from "@/lib/ai/tools";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const { message, context, voice }: NicoleChatRequest = await req.json();
    const workspaceContext = normalizeWorkspaceContext(context);
    await requireTrustedDeviceForIOS(req, workspaceContext?.surface);

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    await saveChatMessage("user", message);

    // 1. Classify intent deterministically — no LLM call
    const recentMessages = await loadRecentMessages();
    const intent = classifyIntent(message, recentMessages);

    // 2. Load context selectively based on intent
    const contextLoaders: Promise<unknown>[] = [
      loadConversationSummaryContext(),
    ];

    // Memory: ~50ms, cheap — load for anything non-casual
    if (intent.shouldSearchMemory) {
      contextLoaders.push(loadMemories(message));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

    // Sources: load when intent says so
    if (intent.shouldSearchSources) {
      contextLoaders.push(loadRelevantSourceContext(message, undefined, "personal"));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

    // 3. Run tools deterministically based on intent (in parallel with context)
    contextLoaders.push(runIntentBasedTooling(intent, message, recentMessages));

    const [summaryText, memoryText, sourceContext, toolResults] = (await Promise.all(
      contextLoaders
    )) as [string | null, string | null, string | null, import("@/lib/ai/tools").ToolExecutionResult[]];

    // 4. Build system prompt with only the context we actually loaded
    const systemPrompt = await buildSystemPrompt({
      conversationSummaries: summaryText || undefined,
      memories: (memoryText as string) || undefined,
      sourceContext: (sourceContext as string) || undefined,
      workspaceContext: formatWorkspaceContextForPrompt(workspaceContext),
    });

    let fullSystemPrompt = systemPrompt + buildToolPromptBlock(toolResults);

    // Voice mode: add instruction to keep responses concise and conversational
    if (voice) {
      fullSystemPrompt += `\n\n## Voice mode active
You are speaking out loud to Roy right now. Critical rules:
- Keep responses SHORT — 1-3 sentences max unless the topic truly demands more.
- Be conversational, not essay-like. No bullet points, no markdown, no headers.
- Speak naturally as if talking face to face.
- Don't say "according to my search" — just give the answer naturally.
- If you have tool results, summarize them conversationally.`;
    }

    const fullMessages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
      { role: "user", content: message },
    ];

    const stream = await chat(fullMessages, { stream: true });

    if (!(stream instanceof ReadableStream)) {
      return NextResponse.json(
        { error: "Streaming is unavailable right now." },
        { status: 503 }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let responseClosed = false;

    const responseStream = new ReadableStream({
      async start(controller) {
        let fullContent = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (responseClosed) break;

            const chunk = decoder.decode(value, { stream: true });
            fullContent += chunk;

            try {
              controller.enqueue(encoder.encode(chunk));
            } catch (error) {
              if (isControllerClosedError(error)) {
                responseClosed = true;
                await reader.cancel();
                break;
              }

              throw error;
            }
          }
        } catch (error) {
          if (!responseClosed && !isControllerClosedError(error)) {
            console.error("Nicole stream error:", error);
          }
        } finally {
          if (fullContent) {
            await saveChatMessage("assistant", fullContent);

            const lastExchange: ChatMessage[] = [
              { role: "user", content: message },
              { role: "assistant", content: fullContent },
            ];

            extractAndStoreMemories(lastExchange).catch(() => {});
            summarizeOldConversations().catch(() => {});
          }

          if (!responseClosed) {
            try {
              controller.close();
            } catch {}
          }
        }
      },
      async cancel() {
        responseClosed = true;
        try {
          await reader.cancel();
        } catch {}
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
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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

function isControllerClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "ERR_INVALID_STATE" ||
    candidate.message?.includes("Controller is already closed") === true
  );
}

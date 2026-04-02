import { NextRequest, NextResponse } from "next/server";
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
  formatToolResultsForPrompt,
  runToolPlanningLoop,
  shouldAttemptToolUse,
} from "@/lib/ai/tools";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const { message }: { message: string } = await req.json();

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    await saveChatMessage("user", message);

    const [memoryText, summaryText, recentMessages, sourceContext] = await Promise.all([
      loadMemories(message),
      loadConversationSummaryContext(),
      loadRecentMessages(),
      loadRelevantSourceContext(message),
    ]);

    const systemPrompt = buildSystemPrompt({
      conversationSummaries: summaryText || undefined,
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
    });

    let fullSystemPrompt = systemPrompt;
    if (shouldAttemptToolUse(message)) {
      const toolPlan = await runToolPlanningLoop({
        systemPrompt,
        recentMessages,
        userMessage: message,
      });
      const toolContext = formatToolResultsForPrompt(toolPlan.toolResults);

      if (toolContext) {
        fullSystemPrompt += `\n\n## Tool results\nNicole called tools before answering. Use these results naturally in the reply. Do not expose internal tool mechanics unless the user explicitly asks.\n\n${toolContext}`;
      }
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

    const responseStream = new ReadableStream({
      async start(controller) {
        let fullContent = "";

        try {
          const reader = stream.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            fullContent += chunk;
            controller.enqueue(encoder.encode(chunk));
          }
        } catch (error) {
          console.error("Nicole stream error:", error);
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

          controller.close();
        }
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

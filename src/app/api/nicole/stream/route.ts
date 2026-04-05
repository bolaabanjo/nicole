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
  formatToolResultsForPrompt,
  runDirectToolRouting,
  runToolPlanningLoop,
  shouldAttemptToolUse,
} from "@/lib/ai/tools";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const { message, context }: NicoleChatRequest = await req.json();
    const workspaceContext = normalizeWorkspaceContext(context);
    await requireTrustedDeviceForIOS(req, workspaceContext?.surface);

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
      loadRelevantSourceContext(message, undefined, "personal"),
    ]);

    const systemPrompt = buildSystemPrompt({
      conversationSummaries: summaryText || undefined,
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
      workspaceContext: formatWorkspaceContextForPrompt(workspaceContext),
    });

    let fullSystemPrompt = systemPrompt;
    const toolResults = await runDirectToolRouting(message, recentMessages);

    if (toolResults.length === 0 && shouldAttemptToolUse(message)) {
      try {
        const toolPlan = await runToolPlanningLoop({
          systemPrompt,
          recentMessages,
          userMessage: message,
        });
        toolResults.push(...toolPlan.toolResults);
      } catch (error) {
        console.error("Tool planning failed, continuing without tools:", error);
      }
    }

    const toolContext = formatToolResultsForPrompt(toolResults);

    if (toolContext) {
      fullSystemPrompt += `\n\n## Tool results\nNicole called tools before answering. CRITICAL RULES:\n- Base your answer ONLY on the tool results below. Do not invent, fabricate, or hallucinate information that is not in the results.\n- If the results are empty, irrelevant, or don't answer the question, say so honestly. Never make up a confident-sounding answer.\n- Summarize what the results actually say. Quote or paraphrase them, don't embellish.\n- Do not expose internal tool mechanics unless the user explicitly asks.\n\n${toolContext}`;
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

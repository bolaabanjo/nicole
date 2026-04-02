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

    // Save the user's message immediately
    await saveChatMessage("user", message);

    // Load context in parallel
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

    // Build full prompt with search results if any
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
    summarizeOldConversations().catch(() => {});

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

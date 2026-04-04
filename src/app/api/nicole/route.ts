import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkspaceContextForPrompt,
  NicoleChatRequest,
  normalizeWorkspaceContext,
} from "@/lib/ai/context";
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
      loadRelevantSourceContext(message, undefined, "personal"),
    ]);

    const systemPrompt = buildSystemPrompt({
      conversationSummaries: summaryText || undefined,
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
      workspaceContext: formatWorkspaceContextForPrompt(workspaceContext),
    });

    // Build full prompt with search results if any
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

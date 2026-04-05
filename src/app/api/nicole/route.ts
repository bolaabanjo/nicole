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
    const { message, context }: NicoleChatRequest = await req.json();
    const workspaceContext = normalizeWorkspaceContext(context);
    await requireTrustedDeviceForIOS(req, workspaceContext?.surface);

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // Save the user's message immediately
    await saveChatMessage("user", message);

    // 1. Classify intent deterministically — no LLM call
    const recentMessages = await loadRecentMessages();
    const intent = classifyIntent(message, recentMessages);

    // 2. Load context selectively based on intent
    const contextLoaders: Promise<unknown>[] = [
      loadConversationSummaryContext(),
    ];

    if (intent.shouldSearchMemory) {
      contextLoaders.push(loadMemories(message));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

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

    const fullSystemPrompt = systemPrompt + buildToolPromptBlock(toolResults);

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

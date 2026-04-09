import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkspaceContextForPrompt,
  NicoleChatRequest,
  normalizeWorkspaceContext,
} from "@/lib/ai/context";
import { buildConversationScopeKey } from "@/lib/ai/conversation-scope";
import {
  getDeclaredClientSurface,
  requireTrustedDeviceForIOS,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import {
  loadActiveOperationalThread,
  syncActiveOperationalThreadFromToolResults,
} from "@/lib/ai/session-thread";
import {
  buildTopicAwareRecentMessages,
  loadActiveTopicState,
  loadTopicContinuityContext,
  shouldPrioritizeActiveTopicContext,
  syncActiveTopicFromTurn,
} from "@/lib/ai/topic-state";
import { loadLinkedTurnContext, saveTurnLink } from "@/lib/ai/turn-links";
import { ChatMessage } from "@/lib/ai/types";
import {
  loadMemories,
  loadRecentMessageRecords,
  loadConversationSummaryContext,
  loadRecentToolActivityContext,
  saveChatMessage,
  extractAndStoreMemories,
  summarizeOldConversations,
  trimPendingUserMessage,
} from "@/lib/ai/memory";
import {
  buildDirectToolResponse,
  buildToolPromptBlock,
  buildToolResultsText,
  classifyIntent,
  executeToolCall,
  runIntentBasedTooling,
} from "@/lib/ai/tools";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const { message, context, sessionId }: NicoleChatRequest = await req.json();
    const workspaceContext = normalizeWorkspaceContext(context);
    const clientSurface = workspaceContext?.surface || getDeclaredClientSurface(req);
    const scopeKey = buildConversationScopeKey({
      surface: clientSurface,
      sessionId,
    });
    await requireTrustedDeviceForIOS(req, workspaceContext?.surface);

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // Save the user's message immediately
    const userRecord = await saveChatMessage("user", message);

    // 1. Classify intent deterministically — no LLM call
    const activeThread = await loadActiveOperationalThread(scopeKey);
    const activeTopic = await loadActiveTopicState(scopeKey);
    const recentRecords = await loadRecentMessageRecords();
    const recentMessages = trimPendingUserMessage(
      buildTopicAwareRecentMessages(recentRecords, activeTopic, message),
      message
    );
    const intent = classifyIntent(message, recentMessages);

    // 2. Load context selectively based on intent
    const isToolDriven = intent.intent === "factual_question" || intent.intent === "weather_question" || intent.intent === "health_question";
    const prioritizeActiveTopic = shouldPrioritizeActiveTopicContext(
      message,
      activeTopic
    );
    const suppressBroadContext =
      prioritizeActiveTopic && activeTopic?.kind !== "general";

    if (
      userRecord?.id &&
      prioritizeActiveTopic &&
      activeTopic?.anchorMessageId
    ) {
      await saveTurnLink({
        messageId: userRecord.id,
        linkedMessageId: activeTopic.anchorMessageId,
        scopeKey,
        linkType: "follow_up_to",
        topicKind: activeTopic.kind,
      });
    }

    const contextLoaders: Promise<unknown>[] = [
      isToolDriven || suppressBroadContext
        ? Promise.resolve(null)
        : loadConversationSummaryContext(message),
    ];

    if (intent.shouldSearchMemory && !isToolDriven && !suppressBroadContext) {
      contextLoaders.push(loadMemories(message));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

    if (intent.shouldSearchSources && !isToolDriven && !suppressBroadContext) {
      contextLoaders.push(loadRelevantSourceContext(message, undefined, "personal"));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

    let activeTopicContextPromise: Promise<string | null> = Promise.resolve(null);
    let linkedTurnContextPromise: Promise<string | null> = Promise.resolve(null);

    if (!isToolDriven && prioritizeActiveTopic) {
      activeTopicContextPromise = loadTopicContinuityContext(activeTopic, scopeKey, message);
      linkedTurnContextPromise = loadLinkedTurnContext(userRecord?.id, scopeKey);
    }

    if (!isToolDriven && !prioritizeActiveTopic) {
      contextLoaders.push(loadRecentToolActivityContext(message));
    } else {
      contextLoaders.push(Promise.resolve(null));
    }

    // 3. Run tools deterministically based on intent (in parallel with context)
    contextLoaders.push(
      runIntentBasedTooling(
        intent,
        message,
        recentMessages,
        clientSurface,
        activeThread
      )
    );

    const [summaryText, memoryText, sourceContext, recentToolActivity, toolResults, activeTopicContext, linkedTurnContext] = (await Promise.all(
      [...contextLoaders, activeTopicContextPromise, linkedTurnContextPromise]
    )) as [
      string | null,
      string | null,
      string | null,
      string | null,
      import("@/lib/ai/tools").ToolExecutionResult[],
      string | null,
      string | null
    ];
    await syncActiveOperationalThreadFromToolResults(message, toolResults, scopeKey);
    const directToolResponse = buildDirectToolResponse(toolResults);
    const continuityContext = [linkedTurnContext, activeTopicContext]
      .filter((section): section is string => Boolean(section && section.trim()))
      .join("\n\n");

    if (directToolResponse) {
      const assistantRecord = await saveChatMessage("assistant", directToolResponse);
      await syncActiveTopicFromTurn({
        scopeKey,
        message,
        assistantMessageId: assistantRecord?.id,
        assistantContent: directToolResponse,
        toolResults,
        workspaceContext,
        sourceContext,
        priorActiveTopic: activeTopic,
      });
      if (assistantRecord?.id && userRecord?.id) {
        await saveTurnLink({
          messageId: assistantRecord.id,
          linkedMessageId: userRecord.id,
          scopeKey,
          linkType: "responds_to",
          topicKind: activeTopic?.kind,
        });
      }

      const lastExchange: ChatMessage[] = [
        { role: "user", content: message },
        { role: "assistant", content: directToolResponse },
      ];
      extractAndStoreMemories(lastExchange).catch(() => {});
      summarizeOldConversations().catch(() => {});

      return NextResponse.json({ content: directToolResponse });
    }

    // 4. Build system prompt with only the context we actually loaded
    const systemPrompt = await buildSystemPrompt({
      conversationSummaries: summaryText || undefined,
      memories: (memoryText as string) || undefined,
      activeTopicContext: continuityContext || undefined,
      recentToolActivity: (recentToolActivity as string) || undefined,
      sourceContext: (sourceContext as string) || undefined,
      workspaceContext: formatWorkspaceContextForPrompt(workspaceContext),
    });

    const hasToolResults = toolResults.length > 0 && toolResults.some(r => r.ok);
    let toolBlock = "";
    let toolContextMessage: ChatMessage | null = null;

    if (hasToolResults && isToolDriven) {
      const resultsText = buildToolResultsText(toolResults);
      toolContextMessage = {
        role: "user",
        content: `[SEARCH RESULTS — answer Roy's question using ONLY this information]\n\n${resultsText}\n\n[END SEARCH RESULTS — now answer the question below using ONLY the data above. If the results don't contain the answer, tell Roy the search didn't cover it. Do NOT make up information.]`,
      };
    } else {
      toolBlock = buildToolPromptBlock(toolResults);
    }

    const fullSystemPrompt = systemPrompt + toolBlock;

    const fullMessages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
      ...(toolContextMessage ? [toolContextMessage] : []),
      { role: "user", content: message },
    ];

    const response = await chat(fullMessages);

    let content =
      typeof response === "string" ? response : String(response);

    // Self-heal: detect unfulfilled tool promises
    const missedQuery = detectUnfulfilledToolPromise(content, hasToolResults, message);
    if (missedQuery) {
      try {
        const healResult = await executeToolCall({
          name: "web_search",
          arguments: { query: missedQuery, limit: 5 },
        });

        if (healResult.ok) {
          const resultsText = buildToolResultsText([healResult]);
          const healMessages: ChatMessage[] = [
            { role: "system", content: fullSystemPrompt },
            ...recentMessages,
            { role: "user", content: message },
            { role: "assistant", content },
            {
              role: "user",
              content: `[SEARCH RESULTS — you said you would search, here are the results. Now give Roy the actual answer.]\n\n${resultsText}\n\n[Answer using ONLY these results. Be direct — Roy is already waiting.]`,
            },
          ];

          const healResponse = await chat(healMessages);
          const healContent = typeof healResponse === "string" ? healResponse : String(healResponse);
          content += "\n\n---\n\n" + healContent;
        }
      } catch (healError) {
        console.error("Self-heal search failed:", healError);
      }
    }

    // Save Nicole's response
    const assistantRecord = await saveChatMessage("assistant", content);
    await syncActiveTopicFromTurn({
      scopeKey,
      message,
      assistantMessageId: assistantRecord?.id,
      assistantContent: content,
      toolResults,
      workspaceContext,
      sourceContext,
      priorActiveTopic: activeTopic,
    });
    if (assistantRecord?.id && userRecord?.id) {
      await saveTurnLink({
        messageId: assistantRecord.id,
        linkedMessageId: userRecord.id,
        scopeKey,
        linkType: "responds_to",
        topicKind: activeTopic?.kind,
      });
    }

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

// ---------------------------------------------------------------------------
// Self-heal: detect when the model promised to use a tool but didn't deliver
// ---------------------------------------------------------------------------

const UNFULFILLED_TOOL_PATTERNS = [
  /\b(?:let me|i(?:'ll| will)|i'm going to|hold on|one moment|searching|looking)\s+(?:search|look|check|find|browse|fetch|pull up|retrieve|get)/i,
  /\b(?:initiated|initiating|starting|running)\s+(?:a |the )?(?:search|web search|lookup|query)/i,
  /\bplease hold\b.*\b(?:search|result|find)/i,
  /\b(?:i'll|let me)\s+(?:get back|come back|return)\s+(?:to you|with)/i,
  /\bshare the findings\b/i,
  /\bretrieve the latest\b/i,
];

function detectUnfulfilledToolPromise(
  response: string,
  hadToolResults: boolean,
  originalMessage?: string
): string | null {
  if (hadToolResults) return null;

  const matchesPattern = UNFULFILLED_TOOL_PATTERNS.some((p) => p.test(response));
  if (!matchesPattern) return null;

  const queryPatterns = [
    /(?:search|look up|find|searching)\s+(?:for\s+|about\s+)?(?:information\s+(?:on|about)\s+)?[""\u201C]?([^""\u201D.\n]+?)[""\u201D]?(?:\.|,|\s+(?:and|to|for you|now|right now))/i,
    /(?:about|for|on)\s+[""\u201C]([^""\u201D]+)[""\u201D]?/i,
  ];

  for (const p of queryPatterns) {
    const match = response.match(p);
    if (match && match[1] && match[1].trim().length > 3) {
      return match[1].trim();
    }
  }

  if (originalMessage) {
    const stripped = originalMessage
      .replace(/^(?:good|great|nice|cool|okay|ok|alright|sure|hey nicole|hey|please|actually)[,.:;!?\s]+/i, "")
      .replace(/^(?:search|search the web|google|look up|find|tell me about|what is|who is)\s+(?:the web\s+)?(?:for\s+)?/i, "")
      .replace(/(?:\s+and\s+tell me.*|\s+for me.*|\?|\.)*$/i, "")
      .trim();
    if (stripped.length > 1) return stripped;
  }

  return null;
}

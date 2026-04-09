import { NextRequest, NextResponse } from "next/server";
import {
  formatWorkspaceContextForPrompt,
  hasWorkspaceContext,
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
  buildToolActivityFeedEntries,
  buildToolPromptBlock,
  buildToolResultsText,
  classifyIntent,
  describeIntentToolActivity,
  executeToolCall,
  generateToolActivityPreface,
  runIntentBasedTooling,
} from "@/lib/ai/tools";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

export async function POST(req: NextRequest) {
  try {
    const {
      message,
      context,
      sessionId,
      voice,
      eventStream,
    }: NicoleChatRequest & { eventStream?: boolean } = await req.json();
    const workspaceContext = normalizeWorkspaceContext(context);
    const clientSurface =
      workspaceContext?.surface || getDeclaredClientSurface(req) || "web";
    const scopeKey = buildConversationScopeKey({
      surface: clientSurface,
      sessionId,
      voice: Boolean(voice),
    });
    await requireTrustedDeviceForIOS(req, workspaceContext?.surface);

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

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

    if (eventStream && !voice) {
      return createStructuredEventStreamResponse({
        message,
        userMessageId: userRecord?.id ?? null,
        workspaceContext,
        clientSurface,
        sessionId: sessionId ?? null,
        scopeKey,
        recentMessages,
        intent,
        activeThread,
        activeTopic,
      });
    }

    const preparedTurn = await prepareNicoleTurn({
      message,
      userMessageId: userRecord?.id ?? null,
      workspaceContext,
      voice: Boolean(voice),
      recentMessages,
      intent,
      clientSurface,
      sessionId: sessionId ?? null,
      scopeKey,
      eventStream: false,
      activeThread,
      activeTopic,
    });
    await syncActiveOperationalThreadFromToolResults(
      message,
      preparedTurn.toolResults,
      scopeKey
    );
    const directToolResponse = buildDirectToolResponse(preparedTurn.toolResults);

    if (directToolResponse) {
      const assistantRecord = await saveChatMessage("assistant", directToolResponse);
      await syncActiveTopicFromTurn({
        scopeKey,
        message,
        assistantMessageId: assistantRecord?.id,
        assistantContent: directToolResponse,
        toolResults: preparedTurn.toolResults,
        workspaceContext,
        sourceContext: preparedTurn.sourceContext,
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

      return new Response(directToolResponse, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const stream = await chat(preparedTurn.fullMessages, { stream: true });

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
          if (fullContent && !responseClosed) {
            // Self-heal: detect unfulfilled tool promises
            const hasToolResults = preparedTurn.hasToolResults;
            const missedQuery = detectUnfulfilledToolPromise(
              fullContent,
              hasToolResults,
              message
            );

            if (missedQuery) {
              // The model promised to search but didn't — run the tool now
              try {
                const healResult = await executeToolCall({
                  name: "web_search",
                  arguments: { query: missedQuery, limit: 5 },
                });

                if (healResult.ok) {
                  const resultsText = buildToolResultsText([healResult]);
                  const healMessages: ChatMessage[] = [
                    { role: "system", content: preparedTurn.fullSystemPrompt },
                    ...recentMessages,
                    { role: "user", content: message },
                    { role: "assistant", content: fullContent },
                    {
                      role: "user",
                      content: `[SEARCH RESULTS — you said you would search, here are the results. Now give Roy the actual answer.]\n\n${resultsText}\n\n[Answer using ONLY these results. Be direct — Roy is already waiting.]`,
                    },
                  ];

                  const healStream = await chat(healMessages, { stream: true });

                  if (healStream instanceof ReadableStream) {
                    // Stream a separator so Roy sees the follow-up
                    try {
                      controller.enqueue(encoder.encode("\n\n---\n\n"));
                    } catch {}

                    const healReader = healStream.getReader();
                    let healContent = "";

                    try {
                      while (true) {
                        const { done: hDone, value: hValue } = await healReader.read();
                        if (hDone || responseClosed) break;

                        const hChunk = decoder.decode(hValue, { stream: true });
                        healContent += hChunk;

                        try {
                          controller.enqueue(encoder.encode(hChunk));
                        } catch {
                          responseClosed = true;
                          await healReader.cancel();
                          break;
                        }
                      }
                    } catch {}

                    // Save the combined response
                    fullContent += "\n\n---\n\n" + healContent;
                  }
                }
              } catch (healError) {
                console.error("Self-heal search failed:", healError);
              }
            }

            const assistantRecord = await saveChatMessage("assistant", fullContent);
            await syncActiveTopicFromTurn({
              scopeKey,
              message,
              assistantMessageId: assistantRecord?.id,
              assistantContent: fullContent,
              toolResults: preparedTurn.toolResults,
              workspaceContext,
              sourceContext: preparedTurn.sourceContext,
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
              { role: "assistant", content: fullContent },
            ];

            extractAndStoreMemories(lastExchange).catch(() => {});
            summarizeOldConversations().catch(() => {});
          } else if (fullContent) {
            const assistantRecord = await saveChatMessage("assistant", fullContent);
            await syncActiveTopicFromTurn({
              scopeKey,
              message,
              assistantMessageId: assistantRecord?.id,
              assistantContent: fullContent,
              toolResults: preparedTurn.toolResults,
              workspaceContext,
              sourceContext: preparedTurn.sourceContext,
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

interface PreparedNicoleTurn {
  fullSystemPrompt: string;
  fullMessages: ChatMessage[];
  toolResults: import("@/lib/ai/tools").ToolExecutionResult[];
  hasToolResults: boolean;
  sourceContext: string | null;
}

interface StructuredEventStreamOptions {
  message: string;
  userMessageId: string | null;
  workspaceContext: ReturnType<typeof normalizeWorkspaceContext>;
  clientSurface: string;
  sessionId: string | null;
  scopeKey: string;
  recentMessages: ChatMessage[];
  intent: ReturnType<typeof classifyIntent>;
  activeThread: Awaited<ReturnType<typeof loadActiveOperationalThread>>;
  activeTopic: Awaited<ReturnType<typeof loadActiveTopicState>>;
}

async function prepareNicoleTurn({
  message,
  userMessageId,
  workspaceContext,
  voice,
  recentMessages,
  intent,
  clientSurface,
  sessionId,
  scopeKey,
  eventStream,
  activeThread,
  activeTopic,
}: {
  message: string;
  userMessageId: string | null;
  workspaceContext: ReturnType<typeof normalizeWorkspaceContext>;
  voice: boolean;
  recentMessages: ChatMessage[];
  intent: ReturnType<typeof classifyIntent>;
  clientSurface: string;
  sessionId: string | null;
  scopeKey: string;
  eventStream: boolean;
  activeThread: Awaited<ReturnType<typeof loadActiveOperationalThread>>;
  activeTopic: Awaited<ReturnType<typeof loadActiveTopicState>>;
}): Promise<PreparedNicoleTurn> {
  const compactWorkspaceFastPath = shouldUseCompactWorkspaceFastPath({
    message,
    intent,
    workspaceContext,
    clientSurface,
    sessionId,
  });
  const isToolDriven =
    intent.intent === "factual_question" ||
    intent.intent === "weather_question" ||
    intent.intent === "health_question";
  const prioritizeActiveTopic =
    compactWorkspaceFastPath ||
    shouldPrioritizeActiveTopicContext(message, activeTopic);
  const suppressBroadContext =
    compactWorkspaceFastPath ||
    (prioritizeActiveTopic && activeTopic?.kind !== "general");

  if (
    userMessageId &&
    prioritizeActiveTopic &&
    activeTopic?.anchorMessageId
  ) {
    await saveTurnLink({
      messageId: userMessageId,
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

  if (!isToolDriven && prioritizeActiveTopic) {
    contextLoaders.push(loadTopicContinuityContext(activeTopic, scopeKey, message));
  } else {
    contextLoaders.push(Promise.resolve(null));
  }

  if (!isToolDriven && !prioritizeActiveTopic && !compactWorkspaceFastPath) {
    contextLoaders.push(loadRecentToolActivityContext(message));
  } else {
    contextLoaders.push(Promise.resolve(null));
  }

  contextLoaders.push(
    runIntentBasedTooling(
      intent,
      message,
      recentMessages,
      clientSurface,
      activeThread
    )
  );

  contextLoaders.push(
    !isToolDriven && prioritizeActiveTopic
      ? loadLinkedTurnContext(userMessageId, scopeKey)
      : Promise.resolve(null)
  );

  const [
    summaryText,
    memoryText,
    sourceContext,
    activeTopicContext,
    recentToolActivity,
    toolResults,
    linkedTurnContext,
  ] =
    (await Promise.all(contextLoaders)) as [
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      import("@/lib/ai/tools").ToolExecutionResult[],
      string | null
    ];

  const continuityContext = [linkedTurnContext, activeTopicContext]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join("\n\n");

  const systemPrompt = await buildSystemPrompt({
    conversationSummaries: summaryText || undefined,
    memories: memoryText || undefined,
    activeTopicContext: continuityContext || undefined,
    recentToolActivity: recentToolActivity || undefined,
    sourceContext: sourceContext || undefined,
    workspaceContext: formatWorkspaceContextForPrompt(workspaceContext),
  });

  const hasToolResults = toolResults.length > 0 && toolResults.some((result) => result.ok);
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

  let fullSystemPrompt = systemPrompt + toolBlock;

  if (eventStream) {
    fullSystemPrompt += `\n\n## UI activity feed
The interface already shows Roy when you are checking, searching, connecting, or reading something.
- Do not narrate progress like "hold on", "let me check", or "I'm looking into it" in your final answer.
- Do not expose raw tool names such as integration_status, web_search, or email_search.
- Once the work is done, answer directly and naturally.
- If Roy needs to take a next step, say that plainly in the final answer.`;
  }

  if (voice) {
    fullSystemPrompt += `\n\n## Voice mode active
You are speaking out loud to Roy right now. Critical rules:
- Keep responses SHORT — 1-3 sentences max unless the topic truly demands more.
- Be conversational, not essay-like. No bullet points, no markdown, no headers.
- Speak naturally as if talking face to face.
- Don't say "according to my search" — just give the answer naturally.
- If you have tool results, summarize them conversationally.`;
  }

  if (compactWorkspaceFastPath) {
    fullSystemPrompt += `\n\n## Compact study mode active
Roy is asking about what is on screen right now.
- Treat the current workspace context as the primary grounding.
- Stay anchored to the current on-screen topic unless Roy clearly changes subjects.
- Do not wander into unrelated memories, summaries, old tool activity, or source retrieval if the current workspace already gives enough context.
- Answer directly and helpfully so Roy can keep moving.`;
  }

  return {
    fullSystemPrompt,
    fullMessages: [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
      ...(toolContextMessage ? [toolContextMessage] : []),
      { role: "user", content: message },
    ],
    toolResults,
    hasToolResults,
    sourceContext: sourceContext || null,
  };
}

function createStructuredEventStreamResponse(
  options: StructuredEventStreamOptions
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        let responseClosed = false;
        let fullContent = "";
        let streamedAssistantContent = false;
        let preparedTurn: PreparedNicoleTurn | null = null;

        const emitEvent = (event: { type: string; text: string }) => {
          try {
            controller.enqueue(
              encoder.encode(`${JSON.stringify(event)}\n`)
            );
          } catch (error) {
            if (isControllerClosedError(error)) {
              responseClosed = true;
              return;
            }

            throw error;
          }
        };

        try {
          const activityPreview = describeIntentToolActivity(
            options.intent,
            options.message,
            options.recentMessages,
            options.clientSurface,
            options.activeThread
          );

          if (activityPreview) {
            const preActionText =
              options.sessionId === "compact"
                ? activityPreview.preActionText || null
                : await generateToolActivityPreface(
                    options.message,
                    activityPreview
                  );

            if (preActionText) {
              emitEvent({ type: "preface", text: preActionText });
            }
          }

          if (activityPreview?.statusText) {
            emitEvent({ type: "status", text: activityPreview.statusText });
          }

          preparedTurn = await prepareNicoleTurn({
            message: options.message,
            userMessageId: options.userMessageId,
            workspaceContext: options.workspaceContext,
            voice: false,
            recentMessages: options.recentMessages,
            intent: options.intent,
            clientSurface: options.clientSurface,
            sessionId: options.sessionId,
            scopeKey: options.scopeKey,
            eventStream: true,
            activeThread: options.activeThread,
            activeTopic: options.activeTopic,
          });
          await syncActiveOperationalThreadFromToolResults(
            options.message,
            preparedTurn.toolResults,
            options.scopeKey
          );

          for (const entry of buildToolActivityFeedEntries(preparedTurn.toolResults)) {
            emitEvent({ type: "tool", text: entry });
          }

          const directToolResponse = buildDirectToolResponse(preparedTurn.toolResults);
          if (directToolResponse) {
            fullContent = directToolResponse;
            emitEvent({ type: "text_delta", text: directToolResponse });
            return;
          }

          emitEvent({
            type: "status",
            text: preparedTurn.toolResults.length > 0 ? "Pulling it together" : "Thinking",
          });

          const stream = await chat(preparedTurn.fullMessages, { stream: true });

          if (!(stream instanceof ReadableStream)) {
            const fallback = "I'm unavailable right now.";
            fullContent = fallback;
            emitEvent({ type: "text_delta", text: fallback });
          } else {
            const reader = stream.getReader();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done || responseClosed) break;

                const chunk = decoder.decode(value, { stream: true });
                if (!chunk) {
                  continue;
                }

                streamedAssistantContent = true;
                fullContent += chunk;
                emitEvent({ type: "text_delta", text: chunk });
              }
            } finally {
              try {
                await reader.cancel();
              } catch {}
            }
          }
        } catch (error) {
          console.error("Nicole structured stream error:", error);

          if (!fullContent && !responseClosed) {
            const fallback = "I'm unavailable right now.";
            fullContent = fallback;
            emitEvent({ type: "text_delta", text: fallback });
          }
        } finally {
          if (fullContent) {
            const assistantRecord = await saveChatMessage("assistant", fullContent);
            await syncActiveTopicFromTurn({
              scopeKey: options.scopeKey,
              message: options.message,
              assistantMessageId: assistantRecord?.id,
              assistantContent: fullContent,
              toolResults: preparedTurn?.toolResults || [],
              workspaceContext: options.workspaceContext,
              sourceContext: preparedTurn?.sourceContext || null,
              priorActiveTopic: options.activeTopic,
            });
            if (assistantRecord?.id && options.userMessageId) {
              await saveTurnLink({
                messageId: assistantRecord.id,
                linkedMessageId: options.userMessageId,
                scopeKey: options.scopeKey,
                linkType: "responds_to",
                topicKind: options.activeTopic?.kind,
              });
            }

            const lastExchange: ChatMessage[] = [
              { role: "user", content: options.message },
              { role: "assistant", content: fullContent },
            ];

            extractAndStoreMemories(lastExchange).catch(() => {});
            summarizeOldConversations().catch(() => {});
          } else if (!streamedAssistantContent && !responseClosed) {
            const fallback = "I'm unavailable right now.";
            await saveChatMessage("assistant", fallback);
          }

          if (!responseClosed) {
            try {
              controller.close();
            } catch {}
          }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
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

function shouldUseCompactWorkspaceFastPath({
  message,
  intent,
  workspaceContext,
  clientSurface,
  sessionId,
}: {
  message: string;
  intent: ReturnType<typeof classifyIntent>;
  workspaceContext: ReturnType<typeof normalizeWorkspaceContext>;
  clientSurface: string;
  sessionId: string | null;
}): boolean {
  if (clientSurface !== "macos" || sessionId !== "compact") {
    return false;
  }

  if (!hasWorkspaceContext(workspaceContext)) {
    return false;
  }

  const hasVisualContext = Boolean(
    workspaceContext?.visualSummary?.trim() ||
      workspaceContext?.visibleContent?.trim() ||
      workspaceContext?.windowTitle?.trim() ||
      workspaceContext?.currentFilePath?.trim()
  );

  if (!hasVisualContext) {
    return false;
  }

  const normalized = message.trim().toLowerCase();

  if (
    /\b(search the web|google\b|gmail\b|zoho\b|email\b|calendar\b|reminder\b|integration\b|weather\b)\b/.test(
      normalized
    )
  ) {
    return false;
  }

  if (intent.intent === "workspace_question") {
    return true;
  }

  if (
    /^(?:yes|yeah|yep|continue|go on|keep going|explain|clarify|simplify|summarize|break down|teach|walk me through|quiz me|test me|help me understand|make it simpler|what does that mean|why|how|so|then)\b/.test(
      normalized
    )
  ) {
    return true;
  }

  return intent.intent === "ambiguous" || intent.intent === "source_question";
}

/**
 * Detects when the model's response promises tool use that never happened.
 * Returns a search query if detected, null otherwise.
 * Falls back to extracting a query from the original user message if
 * the response extraction is too vague (e.g. "that", "it").
 */
function detectUnfulfilledToolPromise(
  response: string,
  hadToolResults: boolean,
  originalMessage?: string
): string | null {
  if (hadToolResults) return null;

  const matchesPattern = UNFULFILLED_TOOL_PATTERNS.some((p) => p.test(response));
  if (!matchesPattern) return null;

  // Try to extract what should be searched from the response
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

  // Fallback: extract query from original user message
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

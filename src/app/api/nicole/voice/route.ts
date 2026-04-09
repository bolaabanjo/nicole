import { NextRequest, NextResponse } from "next/server";
import { normalizeWorkspaceContext } from "@/lib/ai/context";
import { buildConversationScopeKey } from "@/lib/ai/conversation-scope";
import {
  getDeclaredClientSurface,
  requireTrustedDeviceForIOS,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";
import { chat } from "@/lib/ai/router";
import { loadActiveOperationalThread, syncActiveOperationalThreadFromToolResults } from "@/lib/ai/session-thread";
import { loadActiveTopicState, syncActiveTopicFromTurn } from "@/lib/ai/topic-state";
import { saveTurnLink } from "@/lib/ai/turn-links";
import {
  buildToolActivityFeedEntries,
  type ToolExecutionResult,
} from "@/lib/ai/tools";
import {
  buildPreparedVoiceResponseTurn,
  buildVoiceRecentMessages,
  markVoiceTurnCompleted,
  markVoiceTurnConsumed,
  voiceChatOptionsForTurn,
} from "@/lib/ai/voice-runtime";
import {
  extractAndStoreMemories,
  loadRecentMessageRecords,
  saveChatMessage,
  summarizeOldConversations,
} from "@/lib/ai/memory";
import type { ChatMessage } from "@/lib/ai/types";

interface VoiceRouteBody {
  message?: string;
  sessionId?: string;
  surface?: string;
  voiceTurnId?: string | null;
  interruptedVoiceTurnId?: string | null;
  context?: ReturnType<typeof normalizeWorkspaceContext>;
}

interface VoiceLatencyMetric {
  key: string;
  milliseconds: number;
  sinceStartMilliseconds?: number;
  detail?: string;
}

export async function POST(req: NextRequest) {
  try {
    const routeStartedAt = performance.now();
    const body = (await req.json()) as VoiceRouteBody;
    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const workspaceContext = normalizeWorkspaceContext(body.context);
    const clientSurface =
      body.surface ||
      workspaceContext?.surface ||
      getDeclaredClientSurface(req) ||
      "web";
    const scopeKey = buildConversationScopeKey({
      surface: clientSurface,
      sessionId: body.sessionId,
      voice: true,
    });

    const authStartedAt = performance.now();
    await requireTrustedDeviceForIOS(req, clientSurface);
    const authCompletedAt = performance.now();

    const userRecord = await saveChatMessage("user", message);
    const contextStartedAt = performance.now();
    const [activeThread, activeTopic, recentRecords] = await Promise.all([
      loadActiveOperationalThread(scopeKey),
      loadActiveTopicState(scopeKey),
      loadRecentMessageRecords(),
    ]);
    const contextCompletedAt = performance.now();
    const recentMessages = buildVoiceRecentMessages(
      recentRecords,
      activeTopic,
      message
    );

    const prepareStartedAt = performance.now();
    const preparedTurn = await buildPreparedVoiceResponseTurn({
      voiceTurnId: body.voiceTurnId,
      message,
      userMessageId: userRecord?.id ?? null,
      scopeKey,
      surface: clientSurface,
      sessionId: body.sessionId?.trim() || "voice",
      recentMessages,
      activeThread,
      activeTopic,
      workspaceContext,
      interruptedVoiceTurnId: body.interruptedVoiceTurnId,
    });
    const prepareCompletedAt = performance.now();

    await markVoiceTurnConsumed(preparedTurn.plan.voiceTurnId);
    await syncActiveOperationalThreadFromToolResults(
      message,
      preparedTurn.toolResults,
      scopeKey
    );

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          let responseClosed = false;
          let fullContent = "";
          let streamedAssistantContent = false;
          let speechRemainder = "";
          let firstTextMetricEmitted = false;

          const emitEvent = (event: {
            type: string;
            text: string;
            metric?: VoiceLatencyMetric;
          }) => {
            if (responseClosed) {
              return;
            }

            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch (error) {
              if (isControllerClosedError(error)) {
                responseClosed = true;
                return;
              }

              throw error;
            }
          };

          const emitLatencyMetric = (
            key: string,
            milliseconds: number,
            detail?: string
          ) => {
            const metric: VoiceLatencyMetric = {
              key,
              milliseconds: Math.round(milliseconds * 100) / 100,
              sinceStartMilliseconds:
                Math.round((performance.now() - routeStartedAt) * 100) / 100,
              detail,
            };
            emitEvent({ type: "latency", text: key, metric });
          };

          const emitFirstTextMetricIfNeeded = (detail: string) => {
            if (firstTextMetricEmitted) {
              return;
            }
            firstTextMetricEmitted = true;
            emitLatencyMetric(
              "server_first_text_ms",
              performance.now() - routeStartedAt,
              detail
            );
          };

          const emitSpeechBoundaries = (text: string, flush = false) => {
            speechRemainder += text;
            const { segments, remainder } = splitSpeakableSegments(
              speechRemainder,
              flush
            );
            speechRemainder = remainder;

            for (const segment of segments) {
              emitEvent({ type: "speech_boundary", text: segment });
            }
          };

          const emitFullText = (text: string) => {
            if (!text.trim()) {
              return;
            }

            emitFirstTextMetricIfNeeded("deterministic");
            fullContent = text;
            emitEvent({ type: "text", text });
            emitSpeechBoundaries(text, true);
          };

          try {
            emitLatencyMetric(
              "server_auth_ms",
              authCompletedAt - authStartedAt
            );
            emitLatencyMetric(
              "server_context_ms",
              contextCompletedAt - contextStartedAt
            );
            emitLatencyMetric(
              "server_prepare_ms",
              prepareCompletedAt - prepareStartedAt
            );
            emitLatencyMetric(
              "server_prework_ms",
              prepareCompletedAt - routeStartedAt
            );

            if (preparedTurn.plan.preActionText) {
              emitEvent({ type: "status", text: preparedTurn.plan.preActionText });
            }

            if (preparedTurn.plan.statusText) {
              emitEvent({ type: "status", text: preparedTurn.plan.statusText });
            }

            for (const entry of buildToolActivityFeedEntries(preparedTurn.toolResults)) {
              emitEvent({ type: "activity", text: entry });
            }

            const deterministicResponse =
              preparedTurn.voiceDirectToolResponse || preparedTurn.directToolResponse;

            if (deterministicResponse) {
              emitFullText(deterministicResponse);
            } else {
              emitEvent({
                type: "status",
                text:
                  preparedTurn.toolResults.length > 0
                    ? "Pulling it together"
                    : "Thinking",
              });

              const stream = await chat(preparedTurn.fullMessages, {
                stream: true,
                ...voiceChatOptionsForTurn(preparedTurn),
              });
              const modelStartedAt = performance.now();

              if (!(stream instanceof ReadableStream)) {
                emitFullText("I'm unavailable right now.");
              } else {
                const reader = stream.getReader();

                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done || responseClosed) {
                      break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    if (!chunk) {
                      continue;
                    }

                    if (!streamedAssistantContent) {
                      emitLatencyMetric(
                        "server_model_first_chunk_ms",
                        performance.now() - modelStartedAt
                      );
                      emitFirstTextMetricIfNeeded("model");
                    }
                    streamedAssistantContent = true;
                    fullContent += chunk;
                    emitEvent({ type: "text", text: chunk });
                    emitSpeechBoundaries(chunk, false);
                  }
                } finally {
                  try {
                    await reader.cancel();
                  } catch {}
                }
              }
            }
          } catch (error) {
            console.error("Nicole voice stream error:", error);

            if (!fullContent && !responseClosed) {
              const fallback = "I'm unavailable right now.";
              emitEvent({ type: "error", text: fallback });
              emitFullText(fallback);
            }
          } finally {
            if (speechRemainder.trim()) {
              emitSpeechBoundaries("", true);
            }

            if (fullContent) {
              const assistantRecord = await saveChatMessage("assistant", fullContent);
              await syncActiveTopicFromTurn({
                scopeKey,
                message,
                assistantMessageId: assistantRecord?.id,
                assistantContent: fullContent,
                toolResults: preparedTurn.toolResults,
                workspaceContext,
                sourceContext: preparedTurn.sourceContext,
                priorActiveTopic: preparedTurn.activeTopic,
              });

              if (assistantRecord?.id && userRecord?.id) {
                await saveTurnLink({
                  messageId: assistantRecord.id,
                  linkedMessageId: userRecord.id,
                  scopeKey,
                  linkType: "responds_to",
                  topicKind: preparedTurn.activeTopic?.kind,
                });
              }

              const lastExchange: ChatMessage[] = [
                { role: "user", content: message },
                { role: "assistant", content: fullContent },
              ];
              extractAndStoreMemories(lastExchange).catch(() => {});
              summarizeOldConversations().catch(() => {});
            }

            await markVoiceTurnCompleted(preparedTurn.plan.voiceTurnId);
            emitLatencyMetric(
              "server_total_ms",
              performance.now() - routeStartedAt,
              streamedAssistantContent ? "streamed" : "deterministic"
            );

            if (!responseClosed) {
              emitEvent({ type: "done", text: preparedTurn.plan.voiceTurnId });
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
  } catch (error) {
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Nicole voice error:", error);
    return NextResponse.json(
      { error: "I'm unavailable right now." },
      { status: 503 }
    );
  }
}

function splitSpeakableSegments(
  buffer: string,
  flush: boolean
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let current = "";
  const scalars = Array.from(buffer);

  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index] || "";
    current += scalar;

    const next = scalars[index + 1] || "";
    const boundary =
      /[.!?]/.test(scalar) ||
      (/[,\n;:]/.test(scalar) && current.trim().length >= 24) ||
      (current.trim().length >= 90 && /\s/.test(scalar));
    const nextAllowsBreak = next.length === 0 || /\s/.test(next);

    if (boundary && nextAllowsBreak) {
      const segment = current.trim();
      if (segment.length > 0) {
        segments.push(segment);
      }
      current = "";
    }
  }

  if (flush && current.trim()) {
    segments.push(current.trim());
    current = "";
  }

  return {
    segments,
    remainder: current,
  };
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

import { and, desc, eq } from "drizzle-orm";
import {
  loadConversationSummaryContext,
  loadMemories,
  loadRecentToolActivityContext,
  trimPendingUserMessage,
} from "./memory";
import { buildSystemPrompt } from "./personality";
import {
  buildToolPromptBlock,
  buildToolResultsText,
  buildDirectToolResponse,
  classifyIntent,
  describeIntentToolActivity,
  previewIntentToolCalls,
  runIntentBasedTooling,
  type ToolCall,
  type ToolExecutionResult,
} from "./tools";
import type { ActiveOperationalThread } from "./session-thread";
import { loadRelevantSourceContext } from "../search/semantic";
import { db } from "../db/client";
import { turnArtifacts, voiceTurns } from "../db/schema";
import type { ChatMessage } from "./types";
import type { NicoleWorkspaceContext } from "./context";
import { formatWorkspaceContextForPrompt } from "./context";
import {
  buildTopicAwareRecentMessages,
  loadTopicContinuityContext,
  shouldPrioritizeActiveTopicContext,
  type ActiveTopicKind,
  type ActiveTopicState,
} from "./topic-state";
import { loadLinkedTurnContext, saveTurnLink } from "./turn-links";
import { inferMessageTopicKind } from "./topic-routing";

const VOICE_RECENT_MESSAGE_LIMIT = 10;
const VOICE_SUMMARY_LIMIT = 1;
const VOICE_MEMORY_LIMIT = 4;
const VOICE_TOOL_ACTIVITY_LIMIT = 2;
const VOICE_FAST_CONTEXT_WORD_LIMIT = 14;
const VOICE_FAST_CONTEXT_CHAR_LIMIT = 96;
const VOICE_DIRECT_TOOL_NAMES = new Set([
  "integration_status",
  "integration_connect",
  "integration_disconnect",
  "calendar_read",
  "calendar_create_event",
  "email_search",
  "email_read",
  "email_thread_read",
  "email_reply_draft",
  "email_reply_send",
  "email_send",
]);

export type VoiceIntentClass =
  | "conversational"
  | "operational"
  | "visual"
  | "mixed";

export type VoiceAckPolicy = "none" | "system";

export interface VoiceTurnPlan {
  voiceTurnId: string;
  scopeKey: string;
  surface: string;
  sessionId: string;
  transcript: string;
  intentClass: VoiceIntentClass;
  topicKind: ActiveTopicKind | null;
  ackPolicy: VoiceAckPolicy;
  deterministicMode: boolean;
  preActionText: string | null;
  statusText: string | null;
  plannedToolCalls: ToolCall[];
  groundedArtifactIds: string[];
  replyToTurnId: string | null;
  interruptedByTurnId: string | null;
}

export interface PreparedVoiceResponseTurn {
  plan: VoiceTurnPlan;
  intent: ReturnType<typeof classifyIntent>;
  fullSystemPrompt: string;
  fullMessages: ChatMessage[];
  toolResults: ToolExecutionResult[];
  hasToolResults: boolean;
  directToolResponse: string | null;
  voiceDirectToolResponse: string | null;
  sourceContext: string | null;
  activeTopic: ActiveTopicState | null;
}

interface PrepareVoiceTurnInput {
  voiceTurnId?: string | null;
  transcript: string;
  scopeKey: string;
  surface: string;
  sessionId: string;
  recentMessages: ChatMessage[];
  activeThread: ActiveOperationalThread | null;
  activeTopic: ActiveTopicState | null;
  workspaceContext?: NicoleWorkspaceContext | null;
  interruptedVoiceTurnId?: string | null;
}

interface BuildPreparedVoiceTurnInput {
  voiceTurnId?: string | null;
  message: string;
  userMessageId: string | null;
  scopeKey: string;
  surface: string;
  sessionId: string;
  recentMessages: ChatMessage[];
  activeThread: ActiveOperationalThread | null;
  activeTopic: ActiveTopicState | null;
  workspaceContext?: NicoleWorkspaceContext | null;
  interruptedVoiceTurnId?: string | null;
}

export async function prepareVoiceTurnPlan(
  input: PrepareVoiceTurnInput
): Promise<VoiceTurnPlan> {
  const transcript = input.transcript.trim();
  const intent = classifyIntent(transcript, input.recentMessages);
  const plannedToolCalls = previewIntentToolCalls(
    intent,
    transcript,
    input.recentMessages,
    input.surface,
    input.activeThread
  );
  const activityPreview = describeIntentToolActivity(
    intent,
    transcript,
    input.recentMessages,
    input.surface,
    input.activeThread
  );
  const intentClass = inferVoiceIntentClass(
    transcript,
    plannedToolCalls,
    input.workspaceContext
  );
  const topicKind =
    inferVoiceTopicKind(
      transcript,
      input.activeTopic,
      plannedToolCalls,
      input.workspaceContext
    ) ?? null;
  const ackPolicy: VoiceAckPolicy =
    plannedToolCalls.length > 0 || intentClass === "visual" || intentClass === "mixed"
      ? "system"
      : "none";
  const deterministicMode =
    plannedToolCalls.length > 0 &&
    plannedToolCalls.every((toolCall) => VOICE_DIRECT_TOOL_NAMES.has(toolCall.name));
  const preActionText =
    ackPolicy === "system"
      ? chooseVoicePreActionText(plannedToolCalls, activityPreview, transcript)
      : null;
  const statusText = activityPreview?.statusText?.trim() || null;
  const replyToTurnId = await loadLatestVoiceTurnId(input.scopeKey, input.voiceTurnId);
  const groundedArtifactIds = await loadGroundedArtifactIds(
    input.scopeKey,
    input.activeTopic
  );

  const record = {
    scopeKey: input.scopeKey,
    surface: input.surface,
    sessionId: input.sessionId,
    transcript,
    intentClass,
    topicKind,
    ackPolicy,
    deterministicMode: deterministicMode ? "true" : "false",
    preActionText,
    statusText,
    plannedToolCalls,
    groundedArtifactIds,
    replyToTurnId,
    interruptedByTurnId: input.interruptedVoiceTurnId?.trim() || null,
    preparedAt: new Date(),
    updatedAt: new Date(),
  };

  let voiceTurnId = input.voiceTurnId?.trim() || "";

  if (voiceTurnId) {
    await db
      .update(voiceTurns)
      .set(record)
      .where(eq(voiceTurns.id, voiceTurnId));
  } else {
    const inserted = await db
      .insert(voiceTurns)
      .values(record)
      .returning({ id: voiceTurns.id });
    voiceTurnId = inserted[0]?.id || "";
  }

  if (input.interruptedVoiceTurnId?.trim()) {
    await db
      .update(voiceTurns)
      .set({
        interruptedByTurnId: voiceTurnId,
        updatedAt: new Date(),
      })
      .where(eq(voiceTurns.id, input.interruptedVoiceTurnId.trim()));
  }

  return {
    voiceTurnId,
    scopeKey: input.scopeKey,
    surface: input.surface,
    sessionId: input.sessionId,
    transcript,
    intentClass,
    topicKind,
    ackPolicy,
    deterministicMode,
    preActionText,
    statusText,
    plannedToolCalls,
    groundedArtifactIds,
    replyToTurnId,
    interruptedByTurnId: input.interruptedVoiceTurnId?.trim() || null,
  };
}

export async function buildPreparedVoiceResponseTurn(
  input: BuildPreparedVoiceTurnInput
): Promise<PreparedVoiceResponseTurn> {
  const plan = await prepareVoiceTurnPlan({
    voiceTurnId: input.voiceTurnId,
    transcript: input.message,
    scopeKey: input.scopeKey,
    surface: input.surface,
    sessionId: input.sessionId,
    recentMessages: input.recentMessages,
    activeThread: input.activeThread,
    activeTopic: input.activeTopic,
    workspaceContext: input.workspaceContext,
    interruptedVoiceTurnId: input.interruptedVoiceTurnId,
  });
  const message = input.message.trim();
  const intent = classifyIntent(message, input.recentMessages);
  const isToolDriven =
    intent.intent === "factual_question" ||
    intent.intent === "weather_question" ||
    intent.intent === "health_question";
  const prioritizeActiveTopic = shouldPrioritizeActiveTopicContext(
    message,
    input.activeTopic
  );
  const fastVoiceContext = shouldUseFastVoiceContext(
    message,
    intent,
    plan,
    input.activeTopic
  );
  const suppressBroadContext =
    fastVoiceContext ||
    (prioritizeActiveTopic && input.activeTopic?.kind !== "general");

  if (
    input.userMessageId &&
    prioritizeActiveTopic &&
    input.activeTopic?.anchorMessageId
  ) {
    await saveTurnLink({
      messageId: input.userMessageId,
      linkedMessageId: input.activeTopic.anchorMessageId,
      scopeKey: input.scopeKey,
      linkType: "follow_up_to",
      topicKind: input.activeTopic.kind,
    });
  }

  const [
    summaryText,
    memoryText,
    sourceContext,
    activeTopicContext,
    recentToolActivity,
    toolResults,
    linkedTurnContext,
  ] = await Promise.all([
    suppressBroadContext || isToolDriven
      ? Promise.resolve("")
      : loadConversationSummaryContext(message, VOICE_SUMMARY_LIMIT),
    suppressBroadContext || isToolDriven || !intent.shouldSearchMemory
      ? Promise.resolve("")
      : loadMemories(message, VOICE_MEMORY_LIMIT),
    suppressBroadContext || isToolDriven || !intent.shouldSearchSources
      ? Promise.resolve("")
      : loadRelevantSourceContext(message, undefined, "personal"),
    prioritizeActiveTopic
      ? loadTopicContinuityContext(input.activeTopic, input.scopeKey, message, 3)
      : Promise.resolve(""),
    prioritizeActiveTopic || isToolDriven
      ? Promise.resolve("")
      : loadRecentToolActivityContext(message, VOICE_TOOL_ACTIVITY_LIMIT),
    runIntentBasedTooling(
      intent,
      message,
      input.recentMessages,
      input.surface,
      input.activeThread
    ),
    prioritizeActiveTopic
      ? loadLinkedTurnContext(input.userMessageId, input.scopeKey)
      : Promise.resolve(""),
  ]);

  const continuityContext = [linkedTurnContext, activeTopicContext]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join("\n\n");

  const systemPrompt = await buildSystemPrompt({
    conversationSummaries: summaryText || undefined,
    memories: memoryText || undefined,
    activeTopicContext: continuityContext || undefined,
    recentToolActivity: recentToolActivity || undefined,
    sourceContext: sourceContext || undefined,
    workspaceContext: formatWorkspaceContextForPrompt(
      input.workspaceContext || undefined
    ),
  });

  const hasToolResults = toolResults.some((result) => result.ok);
  const directToolResponse = buildDirectToolResponse(toolResults);
  const voiceDirectToolResponse = buildVoiceDirectToolResponse(toolResults);

  let toolContextMessage: ChatMessage | null = null;
  let toolBlock = "";

  if (hasToolResults && isToolDriven) {
    const resultsText = buildToolResultsText(toolResults);
    toolContextMessage = {
      role: "user",
      content:
        `[LIVE RESULTS]\n${resultsText}\n\n` +
        `Answer Roy using only these live results. Keep it spoken, short, and direct. ` +
        `If the results are incomplete, say that plainly and stop.`,
    };
  } else {
    toolBlock = buildToolPromptBlock(toolResults);
  }

  const fullSystemPrompt =
    systemPrompt +
    toolBlock +
    `\n\n## Voice runtime
You are speaking out loud to Roy right now.
- Keep responses short and spoken, not written.
- Use first person naturally. Say "I", not "Nicole", unless Roy asks about your identity.
- Do not narrate hidden progress or internal tools in the final answer.
- If a tool result gives operational truth, treat it as the source of truth.
- For operational tasks, answer the question first. Add interpretation only if it helps.
- No markdown, no bullet points, no headings.`;

  return {
    plan,
    intent,
    fullSystemPrompt,
    fullMessages: [
      { role: "system", content: fullSystemPrompt },
      ...input.recentMessages.slice(-VOICE_RECENT_MESSAGE_LIMIT),
      ...(toolContextMessage ? [toolContextMessage] : []),
      { role: "user", content: message },
    ],
    toolResults,
    hasToolResults,
    directToolResponse,
    voiceDirectToolResponse,
    sourceContext: sourceContext || null,
    activeTopic: input.activeTopic,
  };
}

export function voiceChatOptionsForTurn(
  preparedTurn: PreparedVoiceResponseTurn
): { temperature: number; maxTokens: number } {
  if (preparedTurn.plan.deterministicMode || preparedTurn.voiceDirectToolResponse) {
    return { temperature: 0, maxTokens: 120 };
  }

  switch (preparedTurn.plan.intentClass) {
    case "visual":
      return { temperature: 0.2, maxTokens: 180 };
    case "mixed":
      return { temperature: 0.2, maxTokens: 170 };
    case "operational":
      return { temperature: 0.15, maxTokens: 140 };
    case "conversational":
    default:
      return { temperature: 0.35, maxTokens: 120 };
  }
}

export async function markVoiceTurnConsumed(
  voiceTurnId: string | null | undefined
): Promise<void> {
  if (!voiceTurnId) {
    return;
  }

  await db
    .update(voiceTurns)
    .set({
      consumedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(voiceTurns.id, voiceTurnId));
}

export async function markVoiceTurnCompleted(
  voiceTurnId: string | null | undefined
): Promise<void> {
  if (!voiceTurnId) {
    return;
  }

  await db
    .update(voiceTurns)
    .set({
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(voiceTurns.id, voiceTurnId));
}

export async function loadPreparedVoiceTurn(
  voiceTurnId: string | null | undefined
): Promise<VoiceTurnPlan | null> {
  if (!voiceTurnId) {
    return null;
  }

  const rows = await db
    .select()
    .from(voiceTurns)
    .where(eq(voiceTurns.id, voiceTurnId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    voiceTurnId: row.id,
    scopeKey: row.scopeKey,
    surface: row.surface,
    sessionId: row.sessionId,
    transcript: row.transcript,
    intentClass: (row.intentClass as VoiceIntentClass) || "conversational",
    topicKind: (row.topicKind as ActiveTopicKind | null) || null,
    ackPolicy: (row.ackPolicy as VoiceAckPolicy) || "none",
    deterministicMode: row.deterministicMode === "true",
    preActionText: row.preActionText || null,
    statusText: row.statusText || null,
    plannedToolCalls: Array.isArray(row.plannedToolCalls)
      ? (row.plannedToolCalls as ToolCall[])
      : [],
    groundedArtifactIds: Array.isArray(row.groundedArtifactIds)
      ? (row.groundedArtifactIds as string[])
      : [],
    replyToTurnId: row.replyToTurnId || null,
    interruptedByTurnId: row.interruptedByTurnId || null,
  };
}

function inferVoiceIntentClass(
  transcript: string,
  plannedToolCalls: ToolCall[],
  workspaceContext?: NicoleWorkspaceContext | null
): VoiceIntentClass {
  const lower = transcript.toLowerCase();
  const looksVisual =
    Boolean(workspaceContext?.visualSummary) ||
    Boolean(workspaceContext?.visibleContent) ||
    /\b(what do you see|look at|screen|page|document|diagram|slide|read this|see this)\b/i.test(
      lower
    );
  const hasOperationalTool = plannedToolCalls.length > 0;

  if (looksVisual && hasOperationalTool) {
    return "mixed";
  }

  if (looksVisual) {
    return "visual";
  }

  if (hasOperationalTool) {
    return "operational";
  }

  return "conversational";
}

function inferVoiceTopicKind(
  transcript: string,
  activeTopic: ActiveTopicState | null,
  plannedToolCalls: ToolCall[],
  workspaceContext?: NicoleWorkspaceContext | null
): ActiveTopicKind | null {
  if (workspaceContext?.visualSummary || workspaceContext?.visibleContent) {
    return "vision";
  }

  const firstToolName = plannedToolCalls[0]?.name;
  if (firstToolName?.startsWith("email_")) {
    return "email";
  }
  if (firstToolName?.startsWith("calendar_")) {
    return "calendar";
  }
  if (firstToolName?.startsWith("integration_")) {
    return "integration";
  }
  if (firstToolName === "web_search" || firstToolName === "deep_research") {
    return "web";
  }
  if (firstToolName === "source_search") {
    return "study";
  }
  if (firstToolName?.startsWith("workspace_")) {
    return "workspace";
  }

  return inferMessageTopicKind(transcript) || activeTopic?.kind || null;
}

function chooseVoicePreActionText(
  plannedToolCalls: ToolCall[],
  preview:
    | {
        preActionText?: string;
        statusText?: string;
      }
    | null,
  transcript: string
): string | null {
  const toolName = plannedToolCalls[0]?.name;
  const pools: Record<string, string[]> = {
    integration_status: [
      "Hold on, let me check that for you.",
      "Give me a second, I'm checking that now.",
      "Let me confirm what's connected.",
    ],
    integration_connect: [
      "Hold on, let me set that up.",
      "Okay, I'm starting that now.",
      "Give me a second, I'll get that connected.",
    ],
    integration_disconnect: [
      "Hold on, let me take care of that.",
      "Okay, I'm updating that now.",
      "Give me a second, I'll disconnect it.",
    ],
    calendar_read: [
      "Hold on, let me check your calendar.",
      "Give me a second, I'm checking that now.",
      "Let me see what's on there.",
    ],
    calendar_create_event: [
      "Hold on, let me put that on your calendar.",
      "Okay, I'm setting that up now.",
      "Give me a second, I'll add it.",
    ],
    email_search: [
      "Hold on, let me check your email.",
      "Give me a second, I'm checking that now.",
      "Let me pull that up for you.",
    ],
    email_read: [
      "Hold on, let me open that.",
      "Give me a second, I'm pulling that up.",
      "Let me check that message.",
    ],
    email_thread_read: [
      "Hold on, let me open that thread.",
      "Give me a second, I'm pulling up that conversation.",
      "Let me check the rest of that thread.",
    ],
    email_reply_draft: [
      "Hold on, let me draft that.",
      "Give me a second, I'll write that up.",
      "Okay, let me put that together.",
    ],
    email_reply_send: [
      "Hold on, let me send that.",
      "Okay, I'm sending that now.",
      "Give me a second, I'll send it.",
    ],
    email_send: [
      "Hold on, let me send that.",
      "Okay, I'm sending that now.",
      "Give me a second, I'll send it.",
    ],
    web_search: [
      "Hold on, let me look that up.",
      "Give me a second, I'm checking that now.",
      "Let me verify that for you.",
    ],
    source_search: [
      "Hold on, let me check your notes.",
      "Give me a second, I'm looking through that now.",
      "Let me pull that up for you.",
    ],
    weather_get: [
      "Hold on, let me check that for you.",
      "Give me a second, I'm checking that now.",
      "Let me pull that up.",
    ],
    health_metric_read: [
      "Hold on, let me check that for you.",
      "Give me a second, I'm pulling that up now.",
      "Let me look at that for you.",
    ],
  };

  const variants =
    (toolName && pools[toolName]) ||
    (preview?.preActionText ? [preview.preActionText] : []);

  if (variants.length === 0) {
    return null;
  }

  return variants[stableVoicePhraseIndex(transcript, variants.length)] ?? variants[0] ?? null;
}

function stableVoicePhraseIndex(seed: string, count: number): number {
  if (count <= 1) {
    return 0;
  }

  let hash = 0;
  for (const char of seed) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return hash % count;
}

async function loadLatestVoiceTurnId(
  scopeKey: string,
  excludingVoiceTurnId?: string | null
): Promise<string | null> {
  const rows = await db
    .select({ id: voiceTurns.id })
    .from(voiceTurns)
    .where(eq(voiceTurns.scopeKey, scopeKey))
    .orderBy(desc(voiceTurns.preparedAt))
    .limit(4);

  const candidate = rows.find((row) => row.id !== excludingVoiceTurnId);
  return candidate?.id || null;
}

async function loadGroundedArtifactIds(
  scopeKey: string,
  activeTopic: ActiveTopicState | null
): Promise<string[]> {
  if (!activeTopic?.anchorMessageId) {
    return [];
  }

  const rows = await db
    .select({ id: turnArtifacts.id })
    .from(turnArtifacts)
    .where(
      and(
        eq(turnArtifacts.scopeKey, scopeKey),
        eq(turnArtifacts.chatMessageId, activeTopic.anchorMessageId)
      )
    )
    .orderBy(desc(turnArtifacts.createdAt))
    .limit(6);

  return rows.map((row) => row.id);
}

export function buildVoiceDirectToolResponse(
  toolResults: ToolExecutionResult[]
): string | null {
  if (toolResults.length === 0) {
    return null;
  }

  const latest = toolResults.filter((result) => result.ok).at(-1);
  if (!latest) {
    return toolResults.at(-1)?.error || null;
  }

  switch (latest.name) {
    case "integration_status":
      return buildVoiceIntegrationStatusResponse(latest.output);
    case "integration_connect":
      return buildVoiceIntegrationConnectResponse(latest.output);
    case "integration_disconnect":
      return buildVoiceIntegrationDisconnectResponse(latest.output);
    case "calendar_read":
      return buildVoiceCalendarReadResponse(latest.output);
    case "calendar_create_event":
      return buildVoiceCalendarCreateResponse(latest.output);
    case "email_search":
      return buildVoiceEmailSearchResponse(latest.output);
    case "email_read":
      return buildVoiceEmailReadResponse(latest.output);
    case "email_thread_read":
      return buildVoiceEmailThreadReadResponse(latest.output);
    case "email_reply_draft":
      return buildVoiceEmailDraftResponse(latest.output);
    case "email_reply_send":
    case "email_send":
      return buildVoiceEmailSendResponse(latest.output);
    default:
      return null;
  }
}

function buildVoiceIntegrationStatusResponse(output: unknown): string {
  const record = output as
    | {
        provider?: { title?: string; connected?: boolean; configured?: boolean; status?: string };
        allProviders?: Array<{
          title?: string;
          connected?: boolean;
          configured?: boolean;
          status?: string;
        }>;
      }
    | undefined;

  if (Array.isArray(record?.allProviders) && record.allProviders.length > 0) {
    const summary = record.allProviders
      .slice(0, 3)
      .map((provider) => {
        const title = provider.title || "That service";
        if (provider.connected) return `${title} is connected`;
        if (provider.status === "planned") return `${title} is planned`;
        if (provider.configured) return `${title} isn't connected yet`;
        return `${title} isn't configured yet`;
      })
      .join(". ");
    return `${summary}.`;
  }

  const provider = record?.provider;
  const title = provider?.title || "That integration";
  if (provider?.connected) {
    return `${title} is connected.`;
  }
  if (provider?.status === "planned") {
    return `${title} is planned, but it isn't wired yet.`;
  }
  if (provider?.configured) {
    return `${title} is available, but it isn't connected yet.`;
  }
  return `${title} isn't configured on this Mac yet.`;
}

function buildVoiceIntegrationConnectResponse(output: unknown): string {
  const record = output as
    | { provider?: { title?: string }; browserOpened?: boolean; connectUrl?: string | null }
    | undefined;
  const title = record?.provider?.title || "that integration";
  if (record?.browserOpened) {
    return `I opened the ${title} sign-in flow in your browser. Finish the consent there, then come back to me.`;
  }
  if (record?.connectUrl) {
    return `I have the ${title} sign-in link ready. Open it and finish the consent, then come back to me.`;
  }
  return `I started the ${title} connection flow.`;
}

function buildVoiceIntegrationDisconnectResponse(output: unknown): string {
  const record = output as { provider?: { title?: string } } | undefined;
  const title = record?.provider?.title || "that integration";
  return `I disconnected ${title}.`;
}

function buildVoiceCalendarReadResponse(output: unknown): string {
  const record = output as
    | {
        events?: Array<{
          title?: string;
          startAt?: string | Date;
          endAt?: string | Date;
        }>;
      }
    | undefined;
  const events = Array.isArray(record?.events) ? record.events : [];
  if (events.length === 0) {
    return "I checked your calendar and I didn't find anything in that window.";
  }

  const first = events[0];
  const title = first?.title?.trim() || "an event";
  const start = formatVoiceCalendarDateTime(first?.startAt);
  const end = formatVoiceCalendarDateTime(first?.endAt);
  const more = events.length > 1 ? ` You also have ${events.length - 1} more after that.` : "";
  if (start && end) {
    return `I found ${events.length} event${events.length === 1 ? "" : "s"}. The first is ${title}, from ${start} to ${end}.${more}`;
  }
  if (start) {
    return `I found ${events.length} event${events.length === 1 ? "" : "s"}. The first is ${title}, at ${start}.${more}`;
  }
  return `I found ${events.length} event${events.length === 1 ? "" : "s"} on your calendar.${more}`;
}

function buildVoiceCalendarCreateResponse(output: unknown): string {
  const record = output as
    | {
        event?: {
          title?: string;
          startAt?: string | Date;
          endAt?: string | Date;
        };
      }
    | undefined;
  const title = record?.event?.title?.trim() || "That event";
  const start = formatVoiceCalendarDateTime(record?.event?.startAt);
  const end = formatVoiceCalendarDateTime(record?.event?.endAt);
  if (start && end) {
    return `I put ${title} on your calendar for ${start} to ${end}.`;
  }
  if (start) {
    return `I put ${title} on your calendar for ${start}.`;
  }
  return `I put ${title} on your calendar.`;
}

function buildVoiceEmailSearchResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        results?: Array<{
          subject?: string;
          sender?: string;
          fromAddress?: string;
        }>;
      }
    | undefined;
  const provider = formatVoiceEmailProvider(record?.provider);
  const results = Array.isArray(record?.results) ? record.results : [];
  if (results.length === 0) {
    return `I checked ${provider} and I didn't find anything matching that.`;
  }

  const first = results[0];
  const subject = first?.subject?.trim() || "no subject";
  const sender = first?.sender || first?.fromAddress || "an unknown sender";
  const more = results.length > 1 ? ` There are ${results.length - 1} more like that too.` : "";
  return `I found ${results.length} email${results.length === 1 ? "" : "s"} in ${provider}. The first one is ${subject}, from ${sender}.${more}`;
}

function buildVoiceEmailReadResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        message?: {
          subject?: string;
          sender?: string;
          fromAddress?: string;
          summary?: string;
          bodyText?: string;
        };
      }
    | undefined;
  const provider = formatVoiceEmailProvider(record?.provider);
  const subject = record?.message?.subject?.trim() || "that message";
  const sender =
    record?.message?.sender || record?.message?.fromAddress || "an unknown sender";
  const body =
    record?.message?.summary?.trim() ||
    record?.message?.bodyText?.trim() ||
    "";
  const clipped = body.slice(0, 280);
  if (!clipped) {
    return `I opened ${subject} in ${provider}. It's from ${sender}.`;
  }
  return `I opened ${subject} in ${provider}. It's from ${sender}. ${clipped}${body.length > clipped.length ? "..." : ""}`;
}

function buildVoiceEmailThreadReadResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        messages?: Array<{
          subject?: string;
          sender?: string;
          fromAddress?: string;
          bodyText?: string;
        }>;
        thread?: {
          messages?: Array<{
            subject?: string;
            sender?: string;
            fromAddress?: string;
            bodyText?: string;
          }>;
        };
      }
    | undefined;
  const provider = formatVoiceEmailProvider(record?.provider);
  const messages = Array.isArray(record?.messages)
    ? record.messages
    : Array.isArray(record?.thread?.messages)
      ? record.thread.messages
      : [];
  if (messages.length === 0) {
    return `I opened that thread in ${provider}, but I couldn't pull out any readable messages.`;
  }

  const first = messages[0];
  const subject = first?.subject?.trim() || "that thread";
  const sender = first?.sender || first?.fromAddress || "an unknown sender";
  const more = messages.length > 1 ? ` There are ${messages.length - 1} more messages in it.` : "";
  return `I opened the thread in ${provider}. The first message is ${subject}, from ${sender}.${more}`;
}

function buildVoiceEmailDraftResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        draft?: {
          to?: string;
          subject?: string;
          body?: string;
        };
      }
    | undefined;
  const provider = formatVoiceEmailProvider(record?.provider);
  const to = record?.draft?.to?.trim() || "the recipient";
  const subject = record?.draft?.subject?.trim() || "no subject";
  return `I drafted the reply in ${provider} to ${to}, with the subject ${subject}.`;
}

function buildVoiceEmailSendResponse(output: unknown): string {
  const record = output as
    | {
        provider?: string;
        sent?: {
          to?: string | string[];
          subject?: string;
        };
      }
    | undefined;
  const provider = formatVoiceEmailProvider(record?.provider);
  const to = Array.isArray(record?.sent?.to)
    ? record?.sent?.to?.join(", ")
    : record?.sent?.to;
  const subject = record?.sent?.subject?.trim();
  if (to && subject) {
    return `I sent that email in ${provider} to ${to}, with the subject ${subject}.`;
  }
  if (subject) {
    return `I sent that email in ${provider}, with the subject ${subject}.`;
  }
  return `I sent that email in ${provider}.`;
}

function formatVoiceEmailProvider(provider: unknown): string {
  if (provider === "gmail") {
    return "Gmail";
  }
  if (provider === "zoho_mail") {
    return "Zoho Mail";
  }
  return "your email";
}

function formatVoiceCalendarDateTime(value: string | Date | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function buildVoiceRecentMessages(
  records: Array<ChatMessage & { id: string; createdAt: Date | null }>,
  activeTopic: ActiveTopicState | null,
  currentMessage: string
): ChatMessage[] {
  return trimPendingUserMessage(
    buildTopicAwareRecentMessages(records, activeTopic, currentMessage),
    currentMessage
  ).slice(-VOICE_RECENT_MESSAGE_LIMIT);
}

function shouldUseFastVoiceContext(
  message: string,
  intent: ReturnType<typeof classifyIntent>,
  plan: VoiceTurnPlan,
  activeTopic: ActiveTopicState | null
): boolean {
  if (plan.plannedToolCalls.length > 0) {
    return false;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return true;
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const isShortSpokenTurn =
    wordCount <= VOICE_FAST_CONTEXT_WORD_LIMIT ||
    trimmed.length <= VOICE_FAST_CONTEXT_CHAR_LIMIT;

  if (!isShortSpokenTurn) {
    return false;
  }

  if (shouldPrioritizeActiveTopicContext(trimmed, activeTopic)) {
    return true;
  }

  return intent.intent === "casual" || intent.intent === "ambiguous";
}

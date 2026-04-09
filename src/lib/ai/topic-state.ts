import { and, desc, eq, gte, ne } from "drizzle-orm";
import { conversationState, turnArtifacts } from "@/lib/db/schema";
import { db } from "@/lib/db/client";
import { ChatMessage } from "./types";
import type { NicoleWorkspaceContext } from "./context";
import type { ToolExecutionResult } from "./tools/runtime";
import { buildToolActivityFeedEntries } from "./tools/runtime";
import {
  inferMessageTopicKind,
  isExplicitTopicShift,
  looksLikeTopicFollowUp,
  messageLikelyMatchesTopic,
  shouldCarryTopicContinuity,
  type TopicRoutingKind,
} from "./topic-routing";

const ACTIVE_TOPIC_STATE_KEY = "active_topic_state";
const TOPIC_TTL_MS = 45 * 60 * 1000;
const TOPIC_ARTIFACT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOPIC_CONTEXT_MESSAGE_LIMIT = 18;

export type ActiveTopicKind = TopicRoutingKind;

export interface ActiveTopicState {
  kind: ActiveTopicKind;
  label?: string | null;
  anchorMessageId?: string | null;
  prompt?: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ChatMessageRecord extends ChatMessage {
  id: string;
  createdAt: Date | null;
}

interface SyncActiveTopicParams {
  scopeKey?: string;
  message: string;
  assistantMessageId?: string | null;
  assistantContent?: string | null;
  toolResults?: ToolExecutionResult[];
  workspaceContext?: NicoleWorkspaceContext;
  sourceContext?: string | null;
  priorActiveTopic?: ActiveTopicState | null;
}

interface TurnArtifactInput {
  chatMessageId?: string | null;
  scopeKey: string;
  topicKind: ActiveTopicKind;
  topicLabel?: string | null;
  artifactKind: "tool_result" | "vision" | "source" | "workspace" | "assistant_answer";
  summary: string;
  payload?: unknown;
}

function scopedActiveTopicKey(scopeKey = "global"): string {
  return `${ACTIVE_TOPIC_STATE_KEY}:${scopeKey}`;
}

export async function loadActiveTopicState(
  scopeKey = "global"
): Promise<ActiveTopicState | null> {
  const rows = await db
    .select({ value: conversationState.value })
    .from(conversationState)
    .where(eq(conversationState.key, scopedActiveTopicKey(scopeKey)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const value = rows[0]?.value as ActiveTopicState | null;
  if (!value?.expiresAt) {
    return null;
  }

  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await clearActiveTopicState(scopeKey);
    return null;
  }

  return value;
}

export async function saveActiveTopicState(
  state: Omit<ActiveTopicState, "createdAt" | "expiresAt"> & { ttlMs?: number },
  scopeKey = "global"
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (state.ttlMs ?? TOPIC_TTL_MS));
  const value: ActiveTopicState = {
    kind: state.kind,
    label: state.label ?? null,
    anchorMessageId: state.anchorMessageId ?? null,
    prompt: state.prompt ?? null,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await db
    .insert(conversationState)
    .values({
      key: scopedActiveTopicKey(scopeKey),
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationState.key,
      set: {
        value,
        updatedAt: now,
      },
    });
}

export async function clearActiveTopicState(scopeKey = "global"): Promise<void> {
  await db
    .delete(conversationState)
    .where(eq(conversationState.key, scopedActiveTopicKey(scopeKey)));
}

export function buildTopicAwareRecentMessages(
  records: ChatMessageRecord[],
  activeTopic: ActiveTopicState | null,
  currentMessage: string
): ChatMessage[] {
  if (records.length === 0) {
    return [];
  }

  const fallbackWindow = records.slice(-TOPIC_CONTEXT_MESSAGE_LIMIT);

  if (!activeTopic) {
    return fallbackWindow.map(toChatMessage);
  }

  const followUp = looksLikeTopicFollowUp(currentMessage);
  const matchesTopic = messageLikelyMatchesTopic(currentMessage, activeTopic);

  if (isExplicitTopicShift(currentMessage, activeTopic)) {
    return fallbackWindow.map(toChatMessage);
  }

  if (!followUp && !matchesTopic) {
    return fallbackWindow.map(toChatMessage);
  }

  if (!activeTopic.anchorMessageId) {
    return fallbackWindow.map(toChatMessage);
  }

  const anchorIndex = records.findIndex(
    (record) => record.id === activeTopic.anchorMessageId
  );

  if (anchorIndex < 0) {
    return fallbackWindow.map(toChatMessage);
  }

  const topicWindowStart = Math.max(0, anchorIndex - 2);
  const topicWindow = records.slice(topicWindowStart).slice(-TOPIC_CONTEXT_MESSAGE_LIMIT);

  return topicWindow.map(toChatMessage);
}

export async function loadActiveTopicArtifactContext(
  activeTopic: ActiveTopicState | null,
  scopeKey = "global",
  query?: string,
  limit = 4
): Promise<string> {
  if (!activeTopic) {
    return "";
  }

  const recentCutoff = new Date(Date.now() - TOPIC_ARTIFACT_WINDOW_MS);
  const baseConditions = [
    eq(turnArtifacts.scopeKey, scopeKey),
    eq(turnArtifacts.topicKind, activeTopic.kind),
    gte(turnArtifacts.createdAt, recentCutoff),
  ];

  if (activeTopic.anchorMessageId) {
    baseConditions.push(ne(turnArtifacts.chatMessageId, activeTopic.anchorMessageId));
  }

  const rows = await db
    .select({
      summary: turnArtifacts.summary,
      topicLabel: turnArtifacts.topicLabel,
      createdAt: turnArtifacts.createdAt,
    })
    .from(turnArtifacts)
    .where(and(...baseConditions))
    .orderBy(desc(turnArtifacts.createdAt))
    .limit(limit * 4);

  if (rows.length === 0) {
    return "";
  }

  const ranked = rows
    .map((row) => ({
      row,
      score: scoreTopicArtifact(
        `${query || ""}\n${activeTopic.label || ""}`,
        `${row.topicLabel || ""}\n${row.summary}`
      ),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.row.createdAt?.getTime() || 0) - (a.row.createdAt?.getTime() || 0);
    })
    .slice(0, limit)
    .map((item) => item.row)
    .reverse();

  const title = activeTopic.label
    ? `${humanizeTopicKind(activeTopic.kind)}: ${activeTopic.label}`
    : humanizeTopicKind(activeTopic.kind);

  return [
    `Active topic: ${title}`,
    ...ranked.map((row) => `- ${row.summary}`),
  ].join("\n");
}

export async function loadGroundedTurnArtifactContext(
  activeTopic: ActiveTopicState | null,
  scopeKey = "global",
  limit = 6
): Promise<string> {
  if (!activeTopic?.anchorMessageId) {
    return "";
  }

  const rows = await db
    .select({
      summary: turnArtifacts.summary,
      artifactKind: turnArtifacts.artifactKind,
      createdAt: turnArtifacts.createdAt,
    })
    .from(turnArtifacts)
    .where(
      and(
        eq(turnArtifacts.scopeKey, scopeKey),
        eq(turnArtifacts.chatMessageId, activeTopic.anchorMessageId)
      )
    )
    .orderBy(desc(turnArtifacts.createdAt))
    .limit(limit);

  if (rows.length === 0) {
    return "";
  }

  const lines = rows
    .reverse()
    .map((row) => `- ${row.summary}`);

  return [
    "Grounding from the last relevant turn:",
    ...lines,
  ].join("\n");
}

export async function loadTopicContinuityContext(
  activeTopic: ActiveTopicState | null,
  scopeKey = "global",
  query?: string,
  limit = 4
): Promise<string> {
  if (!activeTopic) {
    return "";
  }

  const [groundedTurnContext, broaderTopicContext] = await Promise.all([
    loadGroundedTurnArtifactContext(activeTopic, scopeKey),
    loadActiveTopicArtifactContext(activeTopic, scopeKey, query, limit),
  ]);

  const followUpInstruction = activeTopic
    ? "Roy's latest message most likely follows up on this current topic. Stay anchored here unless he clearly changes the subject."
    : "";

  return [followUpInstruction, groundedTurnContext, broaderTopicContext]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
}

export function shouldPrioritizeActiveTopicContext(
  message: string,
  activeTopic: ActiveTopicState | null
): boolean {
  return shouldCarryTopicContinuity(message, activeTopic);
}

export async function syncActiveTopicFromTurn({
  scopeKey = "global",
  message,
  assistantMessageId,
  assistantContent,
  toolResults = [],
  workspaceContext,
  sourceContext,
  priorActiveTopic,
}: SyncActiveTopicParams): Promise<void> {
  const nextTopic = inferTopicFromTurn({
    message,
    toolResults,
    workspaceContext,
    sourceContext,
    priorActiveTopic,
    assistantMessageId,
  });

  if (!nextTopic) {
    if (!looksLikeTopicFollowUp(message)) {
      await clearActiveTopicState(scopeKey);
    }
    return;
  }

  const artifacts = buildArtifactsForTurn({
    chatMessageId: assistantMessageId,
    scopeKey,
    topicKind: nextTopic.kind,
    topicLabel: nextTopic.label,
    assistantContent,
    toolResults,
    workspaceContext,
    sourceContext,
  });

  if (artifacts.length > 0) {
    await db.insert(turnArtifacts).values(
      artifacts.map((artifact) => ({
        chatMessageId: artifact.chatMessageId ?? null,
        scopeKey: artifact.scopeKey,
        topicKind: artifact.topicKind,
        topicLabel: artifact.topicLabel ?? null,
        artifactKind: artifact.artifactKind,
        summary: artifact.summary,
        payload: artifact.payload ?? null,
      }))
    );
  }

  await saveActiveTopicState({
    kind: nextTopic.kind,
    label: nextTopic.label,
    anchorMessageId: assistantMessageId ?? priorActiveTopic?.anchorMessageId ?? null,
    prompt: message,
  }, scopeKey);
}

function inferTopicFromTurn(params: {
  message: string;
  toolResults: ToolExecutionResult[];
  workspaceContext?: NicoleWorkspaceContext;
  sourceContext?: string | null;
  priorActiveTopic?: ActiveTopicState | null;
  assistantMessageId?: string | null;
}): Omit<ActiveTopicState, "createdAt" | "expiresAt"> | null {
  const { message, toolResults, workspaceContext, sourceContext, priorActiveTopic, assistantMessageId } =
    params;

  const toolTopic = inferTopicFromTools(toolResults);
  if (toolTopic) {
    return {
      kind: toolTopic.kind,
      label: toolTopic.label,
      anchorMessageId: assistantMessageId ?? null,
      prompt: message,
    };
  }

  const visionLabel = inferVisionLabel(workspaceContext);
  if (visionLabel) {
    return {
      kind: "vision",
      label: visionLabel,
      anchorMessageId: assistantMessageId ?? null,
      prompt: message,
    };
  }

  if (sourceContext?.trim()) {
    return {
      kind: "study",
      label: extractSourceLabel(sourceContext),
      anchorMessageId: assistantMessageId ?? null,
      prompt: message,
    };
  }

  if (priorActiveTopic && looksLikeTopicFollowUp(message)) {
    return {
      kind: priorActiveTopic.kind,
      label: priorActiveTopic.label ?? null,
      anchorMessageId: priorActiveTopic.anchorMessageId ?? assistantMessageId ?? null,
      prompt: message,
    };
  }

  const explicitTopicShift = priorActiveTopic
    ? inferMessageTopicKind(message)
    : null;
  if (explicitTopicShift && explicitTopicShift !== priorActiveTopic?.kind) {
    return {
      kind: explicitTopicShift,
      label: null,
      anchorMessageId: assistantMessageId ?? null,
      prompt: message,
    };
  }

  return null;
}

function inferTopicFromTools(
  toolResults: ToolExecutionResult[]
): { kind: ActiveTopicKind; label?: string | null } | null {
  const successful = toolResults.filter((result) => result.ok);
  if (successful.length === 0) {
    return null;
  }

  const latest = successful[successful.length - 1];

  if (latest.name.startsWith("integration_")) {
    const output = latest.output as
      | { provider?: { title?: string } }
      | undefined;
    return {
      kind: "integration",
      label: output?.provider?.title || null,
    };
  }

  if (latest.name.startsWith("email_")) {
    const output = latest.output as
      | {
          message?: { subject?: string };
          provider?: string;
        }
      | undefined;
    return {
      kind: "email",
      label: output?.message?.subject || output?.provider || "email",
    };
  }

  if (latest.name.startsWith("calendar_")) {
    const output = latest.output as
      | {
          event?: { title?: string };
        }
      | undefined;
    return {
      kind: "calendar",
      label: output?.event?.title || "calendar",
    };
  }

  if (latest.name === "web_search" || latest.name === "deep_research") {
    const query =
      typeof latest.input.query === "string" ? latest.input.query.trim() : null;
    return {
      kind: "web",
      label: query || "web lookup",
    };
  }

  if (latest.name === "source_search") {
    const query =
      typeof latest.input.query === "string" ? latest.input.query.trim() : null;
    return {
      kind: "study",
      label: query || "source material",
    };
  }

  if (latest.name.startsWith("workspace_")) {
    return {
      kind: "workspace",
      label: "workspace",
    };
  }

  return null;
}

function buildArtifactsForTurn(params: {
  chatMessageId?: string | null;
  scopeKey: string;
  topicKind: ActiveTopicKind;
  topicLabel?: string | null;
  assistantContent?: string | null;
  toolResults: ToolExecutionResult[];
  workspaceContext?: NicoleWorkspaceContext;
  sourceContext?: string | null;
}): TurnArtifactInput[] {
  const artifacts: TurnArtifactInput[] = [];

  const assistantSummary = summarizeAssistantContent(params.assistantContent);
  if (assistantSummary) {
    artifacts.push({
      chatMessageId: params.chatMessageId,
      scopeKey: params.scopeKey,
      topicKind: params.topicKind,
      topicLabel: params.topicLabel,
      artifactKind: "assistant_answer",
      summary: assistantSummary,
      payload: {
        excerpt: params.assistantContent?.slice(0, 1200) || null,
      },
    });
  }

  for (const result of params.toolResults.filter((item) => item.ok)) {
    for (const summary of buildToolActivityFeedEntries([result])) {
      artifacts.push({
        chatMessageId: params.chatMessageId,
        scopeKey: params.scopeKey,
        topicKind: params.topicKind,
        topicLabel: params.topicLabel,
        artifactKind: "tool_result",
        summary,
        payload: {
          toolName: result.name,
          input: result.input,
          output: result.output,
        },
      });
    }
  }

  const visionSummary = summarizeWorkspaceContext(params.workspaceContext);
  if (visionSummary) {
    artifacts.push({
      chatMessageId: params.chatMessageId,
      scopeKey: params.scopeKey,
      topicKind: params.topicKind,
      topicLabel: params.topicLabel,
      artifactKind: "vision",
      summary: visionSummary,
      payload: params.workspaceContext,
    });
  }

  const sourceSummary = summarizeSourceContext(params.sourceContext);
  if (sourceSummary) {
    artifacts.push({
      chatMessageId: params.chatMessageId,
      scopeKey: params.scopeKey,
      topicKind: params.topicKind,
      topicLabel: params.topicLabel,
      artifactKind: "source",
      summary: sourceSummary,
      payload: {
        sourceContext: params.sourceContext,
      },
    });
  }

  return artifacts.slice(0, 8);
}

function summarizeAssistantContent(content?: string | null): string | null {
  const trimmed = content?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/\s+/g, " ")
    .replace(/```[\s\S]*?```/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const clipped = normalized.slice(0, 260);
  return `Nicole answered: ${clipped}${normalized.length > clipped.length ? "..." : ""}`;
}

function summarizeWorkspaceContext(
  workspaceContext?: NicoleWorkspaceContext
): string | null {
  if (!workspaceContext) {
    return null;
  }

  if (workspaceContext.visualSummary?.trim()) {
    return `Saw ${workspaceContext.visualSummary.trim()}`;
  }

  if (workspaceContext.currentFilePath?.trim()) {
    return `Used visual context from ${workspaceContext.currentFilePath.trim()}`;
  }

  if (workspaceContext.windowTitle?.trim()) {
    return `Used visual context from ${workspaceContext.windowTitle.trim()}`;
  }

  if (workspaceContext.visibleContent?.trim()) {
    return `Used visible content: ${workspaceContext.visibleContent.trim().slice(0, 180)}`;
  }

  return null;
}

function summarizeSourceContext(sourceContext?: string | null): string | null {
  const trimmed = sourceContext?.trim();
  if (!trimmed) {
    return null;
  }

  return `Referenced source material: ${trimmed.slice(0, 220)}`;
}

function extractSourceLabel(sourceContext: string): string {
  const firstLine = sourceContext
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ? firstLine.slice(0, 80) : "source material";
}

function inferVisionLabel(workspaceContext?: NicoleWorkspaceContext): string | null {
  if (!workspaceContext) {
    return null;
  }

  return (
    workspaceContext.currentFilePath ||
    workspaceContext.windowTitle ||
    workspaceContext.activeApp ||
    workspaceContext.visualSummary ||
    (workspaceContext.visibleContent
      ? workspaceContext.visibleContent.slice(0, 80)
      : null) ||
    null
  );
}

function scoreTopicArtifact(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]{2,}/g);

  if (!terms || terms.length === 0) {
    return 0;
  }

  const haystack = text.toLowerCase();
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0
  );
}

function humanizeTopicKind(kind: ActiveTopicKind): string {
  switch (kind) {
    case "integration":
      return "Integration";
    case "email":
      return "Email";
    case "calendar":
      return "Calendar";
    case "vision":
      return "Current visual topic";
    case "study":
      return "Study topic";
    case "web":
      return "Web research";
    case "workspace":
      return "Workspace";
    case "general":
      return "Conversation";
  }
}

function toChatMessage(record: ChatMessageRecord): ChatMessage {
  return {
    role: record.role,
    content: record.content,
  };
}

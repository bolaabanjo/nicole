import { NextRequest, NextResponse } from "next/server";
import { normalizeWorkspaceContext } from "@/lib/ai/context";
import { buildConversationScopeKey } from "@/lib/ai/conversation-scope";
import {
  getDeclaredClientSurface,
  requireTrustedDeviceForIOS,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";
import { loadActiveOperationalThread } from "@/lib/ai/session-thread";
import { loadActiveTopicState } from "@/lib/ai/topic-state";
import { loadRecentMessageRecords } from "@/lib/ai/memory";
import {
  buildVoiceRecentMessages,
  prepareVoiceTurnPlan,
} from "@/lib/ai/voice-runtime";

interface VoicePrepareBody {
  transcript?: string;
  sessionId?: string;
  surface?: string;
  isFinal?: boolean;
  voiceTurnId?: string | null;
  interruptedVoiceTurnId?: string | null;
  context?: ReturnType<typeof normalizeWorkspaceContext>;
}

export async function POST(req: NextRequest) {
  try {
    const routeStartedAt = performance.now();
    const body = (await req.json()) as VoicePrepareBody;
    const transcript = body.transcript?.trim();

    if (!transcript) {
      return NextResponse.json(
        { error: "Transcript is required" },
        { status: 400 }
      );
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
      transcript
    );

    const planStartedAt = performance.now();
    const plan = await prepareVoiceTurnPlan({
      voiceTurnId: body.voiceTurnId,
      transcript,
      scopeKey,
      surface: clientSurface,
      sessionId: body.sessionId?.trim() || "voice",
      recentMessages,
      activeThread,
      activeTopic,
      workspaceContext,
      interruptedVoiceTurnId: body.interruptedVoiceTurnId,
    });
    const planCompletedAt = performance.now();

    return NextResponse.json({
      voiceTurnId: plan.voiceTurnId,
      intentClass: plan.intentClass,
      topicKind: plan.topicKind,
      ackPolicy: plan.ackPolicy,
      deterministicMode: plan.deterministicMode,
      preActionText: plan.preActionText,
      statusText: plan.statusText,
      toolPlan: plan.plannedToolCalls.map((toolCall) => toolCall.name),
      replyToTurnId: plan.replyToTurnId,
      groundedArtifactIds: plan.groundedArtifactIds,
      interruptedByTurnId: plan.interruptedByTurnId,
      isFinal: Boolean(body.isFinal),
      latency: {
        totalMilliseconds: Math.round((planCompletedAt - routeStartedAt) * 100) / 100,
        authMilliseconds: Math.round((authCompletedAt - authStartedAt) * 100) / 100,
        contextMilliseconds: Math.round((contextCompletedAt - contextStartedAt) * 100) / 100,
        planMilliseconds: Math.round((planCompletedAt - planStartedAt) * 100) / 100,
      },
    });
  } catch (error) {
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Nicole voice prepare error:", error);
    return NextResponse.json(
      { error: "I couldn't prepare that voice turn." },
      { status: 503 }
    );
  }
}

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
import { warmChatRuntime } from "@/lib/ai/router";

interface VoiceWarmBody {
  sessionId?: string;
  surface?: string;
  context?: ReturnType<typeof normalizeWorkspaceContext>;
}

export async function POST(req: NextRequest) {
  try {
    const startedAt = performance.now();
    const body = (await req.json()) as VoiceWarmBody;
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

    await requireTrustedDeviceForIOS(req, clientSurface);

    const prefetchStartedAt = performance.now();
    await Promise.all([
      loadActiveOperationalThread(scopeKey),
      loadActiveTopicState(scopeKey),
      loadRecentMessageRecords(),
      warmChatRuntime(),
    ]);

    return NextResponse.json({
      warmed: true,
      scopeKey,
      surface: clientSurface,
      latency: {
        totalMilliseconds: Math.round((performance.now() - startedAt) * 100) / 100,
        prefetchMilliseconds:
          Math.round((performance.now() - prefetchStartedAt) * 100) / 100,
      },
    });
  } catch (error) {
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Nicole voice warm error:", error);
    return NextResponse.json(
      { error: "I couldn't warm the voice runtime." },
      { status: 503 }
    );
  }
}

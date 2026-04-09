import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversationState } from "@/lib/db/schema";

const ACTIVE_OPERATIONAL_THREAD_KEY = "active_operational_thread";
const THREAD_TTL_MS = 20 * 60 * 1000;

export type OperationalThreadKind = "integration";
export type OperationalThreadAction = "connect" | "status" | "disconnect";

export interface ActiveOperationalThread {
  kind: OperationalThreadKind;
  action: OperationalThreadAction;
  providerId?: string | null;
  providerLabel?: string | null;
  prompt?: string | null;
  createdAt: string;
  expiresAt: string;
}

function scopedOperationalThreadKey(scopeKey = "global"): string {
  return `${ACTIVE_OPERATIONAL_THREAD_KEY}:${scopeKey}`;
}

export async function loadActiveOperationalThread(
  scopeKey = "global"
): Promise<ActiveOperationalThread | null> {
  const rows = await db
    .select({
      value: conversationState.value,
    })
    .from(conversationState)
    .where(eq(conversationState.key, scopedOperationalThreadKey(scopeKey)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const value = rows[0]?.value as ActiveOperationalThread | null;
  if (!value?.expiresAt) {
    return null;
  }

  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await clearActiveOperationalThreadForScope(scopeKey);
    return null;
  }

  return value;
}

export async function saveActiveOperationalThread(
  thread: Omit<ActiveOperationalThread, "createdAt" | "expiresAt"> & {
    ttlMs?: number;
  },
  scopeKey = "global"
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (thread.ttlMs ?? THREAD_TTL_MS));
  const value: ActiveOperationalThread = {
    kind: thread.kind,
    action: thread.action,
    providerId: thread.providerId ?? null,
    providerLabel: thread.providerLabel ?? null,
    prompt: thread.prompt ?? null,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await db
    .insert(conversationState)
    .values({
      key: scopedOperationalThreadKey(scopeKey),
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

export async function clearActiveOperationalThread(): Promise<void> {
  await clearActiveOperationalThreadForScope("global");
}

export async function clearActiveOperationalThreadForScope(
  scopeKey = "global"
): Promise<void> {
  await db
    .delete(conversationState)
    .where(eq(conversationState.key, scopedOperationalThreadKey(scopeKey)));
}

export async function syncActiveOperationalThreadFromToolResults(
  message: string,
  toolResults: Array<{
    name: string;
    output?: unknown;
  }>,
  scopeKey = "global"
): Promise<void> {
  const latestIntegration = [...toolResults]
    .reverse()
    .find((result) =>
      ["integration_connect", "integration_status", "integration_disconnect"].includes(
        result.name
      )
    );

  if (!latestIntegration) {
    if (toolResults.length > 0) {
      await clearActiveOperationalThreadForScope(scopeKey);
    }
    return;
  }

  const output = latestIntegration.output as
    | {
        provider?: { providerId?: string; title?: string };
      }
    | undefined;

  await saveActiveOperationalThread({
    kind: "integration",
    action:
      latestIntegration.name === "integration_disconnect"
        ? "disconnect"
        : latestIntegration.name === "integration_status"
          ? "status"
          : "connect",
    providerId: output?.provider?.providerId || null,
    providerLabel: output?.provider?.title || null,
    prompt: message,
  }, scopeKey);
}

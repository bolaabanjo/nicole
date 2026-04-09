import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chatMessages, turnArtifacts, turnLinks } from "@/lib/db/schema";
import type { ActiveTopicKind } from "./topic-state";

export type TurnLinkType = "follow_up_to" | "responds_to";

interface SaveTurnLinkInput {
  messageId: string;
  linkedMessageId: string;
  scopeKey: string;
  linkType: TurnLinkType;
  topicKind?: ActiveTopicKind | null;
}

export async function saveTurnLink(input: SaveTurnLinkInput): Promise<void> {
  if (!input.messageId || !input.linkedMessageId) {
    return;
  }

  await db.insert(turnLinks).values({
    messageId: input.messageId,
    linkedMessageId: input.linkedMessageId,
    scopeKey: input.scopeKey,
    linkType: input.linkType,
    topicKind: input.topicKind ?? null,
  });
}

export async function loadLinkedTurnContext(
  messageId: string | null | undefined,
  scopeKey: string,
  limit = 6
): Promise<string> {
  if (!messageId) {
    return "";
  }

  const linkRows = await db
    .select({
      linkedMessageId: turnLinks.linkedMessageId,
      linkType: turnLinks.linkType,
    })
    .from(turnLinks)
    .where(
      and(
        eq(turnLinks.messageId, messageId),
        eq(turnLinks.scopeKey, scopeKey)
      )
    )
    .orderBy(desc(turnLinks.createdAt))
    .limit(1);

  const linkedMessageId = linkRows[0]?.linkedMessageId;
  if (!linkedMessageId) {
    return "";
  }

  const [linkedMessages, artifactRows] = await Promise.all([
    db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, linkedMessageId))
      .limit(1),
    db
      .select({
        summary: turnArtifacts.summary,
        artifactKind: turnArtifacts.artifactKind,
      })
      .from(turnArtifacts)
      .where(
        and(
          eq(turnArtifacts.scopeKey, scopeKey),
          eq(turnArtifacts.chatMessageId, linkedMessageId)
        )
      )
      .orderBy(desc(turnArtifacts.createdAt))
      .limit(limit),
  ]);

  const linkedMessage = linkedMessages[0];
  const sections: string[] = [];

  if (linkedMessage?.content?.trim()) {
    sections.push(
      `Direct follow-up target: ${clipText(linkedMessage.content.trim(), 320)}`
    );
  }

  if (artifactRows.length > 0) {
    sections.push(
      [
        "Grounded details from that exact turn:",
        ...artifactRows.reverse().map((row) => `- ${row.summary}`),
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...`;
}


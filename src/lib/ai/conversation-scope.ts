export interface ConversationScopeInput {
  surface?: string | null;
  sessionId?: string | null;
  voice?: boolean;
}

const DEFAULT_SURFACE = "web";
const DEFAULT_SESSION = "default";
const MAX_SCOPE_SEGMENT_LENGTH = 48;

function normalizeScopeSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SCOPE_SEGMENT_LENGTH);

  return normalized || null;
}

export function buildConversationScopeKey({
  surface,
  sessionId,
  voice,
}: ConversationScopeInput): string {
  const normalizedSurface =
    normalizeScopeSegment(surface) || DEFAULT_SURFACE;
  const normalizedSession =
    normalizeScopeSegment(sessionId) ||
    (voice ? "voice" : DEFAULT_SESSION);

  return `${normalizedSurface}:${normalizedSession}`;
}


export type TopicRoutingKind =
  | "integration"
  | "email"
  | "calendar"
  | "vision"
  | "study"
  | "web"
  | "workspace"
  | "general";

export interface TopicRoutingState {
  kind: TopicRoutingKind;
  label?: string | null;
}

const TOPIC_FOLLOW_UP_PATTERNS = [
  /^(?:continue|go on|keep going|go ahead)[.!?]*$/i,
  /^(?:yes|yeah|yep|sure|okay|ok|alright|nah|nope|no)\b/i,
  /^(?:that|this|it|those|them)[.!?]*$/i,
  /^(?:explain|summarize|clarify|break down|expand on)\b/i,
  /^(?:what else|and then|then what|what next)\b/i,
  /\b(?:explain|help me understand|teach me|walk me through)\b/i,
];

const TOPIC_KEYWORD_MATCHES: Record<TopicRoutingKind, RegExp> = {
  integration: /\b(connect|connected|disconnect|calendar|gmail|google calendar|zoho|oauth|auth|integration|sign in|sign-in)\b/i,
  email: /\b(email|mail|reply|thread|message|inbox|sender|subject)\b/i,
  calendar: /\b(calendar|meeting|meetings|event|events|schedule|availability|free|busy|tomorrow|today|wednesday|thursday|friday|monday|tuesday|saturday|sunday)\b/i,
  vision: /\b(see|screen|page|document|slide|diagram|look at|what do you see|visible|on my screen|shown here)\b/i,
  study: /\b(notes|source|paper|document|study|explain|teach|understand|limits|calculus|math|chapter|textbook)\b/i,
  web: /\b(search|web|research|look up|latest|current|news|google)\b/i,
  workspace: /\b(workspace|file|folder|context|codebase|repo|repository)\b/i,
  general: /$^/,
};

const TOPIC_ORDER: TopicRoutingKind[] = [
  "integration",
  "email",
  "calendar",
  "vision",
  "study",
  "web",
  "workspace",
];

export function looksLikeTopicFollowUp(message: string): boolean {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return TOPIC_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function messageLikelyMatchesTopic(
  message: string,
  topic: TopicRoutingState
): boolean {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (TOPIC_KEYWORD_MATCHES[topic.kind].test(normalized)) {
    return true;
  }

  if (topic.label) {
    const terms = topic.label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2);

    if (terms.some((term) => normalized.includes(term))) {
      return true;
    }
  }

  return false;
}

export function inferMessageTopicKind(message: string): TopicRoutingKind | null {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  for (const kind of TOPIC_ORDER) {
    if (TOPIC_KEYWORD_MATCHES[kind].test(normalized)) {
      return kind;
    }
  }

  return null;
}

export function isExplicitTopicShift(
  message: string,
  activeTopic: TopicRoutingState | null
): boolean {
  if (!activeTopic) {
    return false;
  }

  if (looksLikeTopicFollowUp(message)) {
    return false;
  }

  const hintedTopic = inferMessageTopicKind(message);
  if (!hintedTopic || hintedTopic === "general") {
    return false;
  }

  return hintedTopic !== activeTopic.kind;
}

export function shouldCarryTopicContinuity(
  message: string,
  activeTopic: TopicRoutingState | null
): boolean {
  if (!activeTopic) {
    return false;
  }

  if (isExplicitTopicShift(message, activeTopic)) {
    return false;
  }

  return (
    looksLikeTopicFollowUp(message) || messageLikelyMatchesTopic(message, activeTopic)
  );
}

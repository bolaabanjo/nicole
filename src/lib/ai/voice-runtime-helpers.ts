export interface VoiceToolExecutionResultLike {
  ok: boolean;
  name: string;
  error?: string | null;
  output?: unknown;
}

export interface VoiceTopicStateLike {
  kind: string;
  label?: string | null;
  anchorMessageId?: string | null;
}

export interface VoiceRecentMessageLike {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VoiceRecentMessageRecordLike extends VoiceRecentMessageLike {
  id: string;
  createdAt: Date | null;
}

const VOICE_RECENT_MESSAGE_LIMIT = 10;
const TOPIC_CONTEXT_MESSAGE_LIMIT = 18;
const TOPIC_FOLLOW_UP_PATTERNS = [
  /^(?:continue|go on|keep going|go ahead)[.!?]*$/i,
  /^(?:yes|yeah|yep|sure|okay|ok|alright|nah|nope|no)\b/i,
  /^(?:that|this|it|those|them)[.!?]*$/i,
  /^(?:explain|summarize|clarify|break down|expand on)\b/i,
  /^(?:what else|and then|then what|what next)\b/i,
  /\b(?:explain|help me understand|teach me|walk me through)\b/i,
];

const TOPIC_KEYWORD_MATCHES: Record<string, RegExp> = {
  integration:
    /\b(connect|connected|disconnect|calendar|gmail|google calendar|zoho|oauth|auth|integration|sign in|sign-in)\b/i,
  email: /\b(email|mail|reply|thread|message|inbox|sender|subject)\b/i,
  calendar:
    /\b(calendar|meeting|meetings|event|events|schedule|availability|free|busy|tomorrow|today|wednesday|thursday|friday|monday|tuesday|saturday|sunday)\b/i,
  vision:
    /\b(see|screen|page|document|slide|diagram|look at|what do you see|visible|on my screen|shown here)\b/i,
  study:
    /\b(notes|source|paper|document|study|explain|teach|understand|limits|calculus|math|chapter|textbook)\b/i,
  web: /\b(search|web|research|look up|latest|current|news|google)\b/i,
  workspace: /\b(workspace|file|folder|context|codebase|repo|repository)\b/i,
  general: /$^/,
};

const TOPIC_ORDER = [
  "integration",
  "email",
  "calendar",
  "vision",
  "study",
  "web",
  "workspace",
];

export function buildVoiceDirectToolResponse(
  toolResults: VoiceToolExecutionResultLike[]
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

export function buildVoiceRecentMessages(
  records: VoiceRecentMessageRecordLike[],
  activeTopic: VoiceTopicStateLike | null,
  currentMessage: string
): VoiceRecentMessageLike[] {
  return trimPendingUserMessage(
    buildTopicAwareRecentMessages(records, activeTopic, currentMessage),
    currentMessage
  ).slice(-VOICE_RECENT_MESSAGE_LIMIT);
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

function trimPendingUserMessage(
  messages: VoiceRecentMessageLike[],
  pendingUserMessage: string
): VoiceRecentMessageLike[] {
  const trimmed = pendingUserMessage.trim();
  if (!trimmed || messages.length === 0) {
    return messages;
  }

  const last = messages[messages.length - 1];
  if (last?.role === "user" && last.content.trim() === trimmed) {
    return messages.slice(0, -1);
  }

  return messages;
}

function buildTopicAwareRecentMessages(
  records: VoiceRecentMessageRecordLike[],
  activeTopic: VoiceTopicStateLike | null,
  currentMessage: string
): VoiceRecentMessageLike[] {
  if (records.length === 0) {
    return [];
  }

  const fallbackWindow = records
    .slice(-TOPIC_CONTEXT_MESSAGE_LIMIT)
    .map(toVoiceRecentMessage);

  if (!activeTopic) {
    return fallbackWindow;
  }

  const followUp = looksLikeTopicFollowUp(currentMessage);
  const matchesTopic = messageLikelyMatchesTopic(currentMessage, activeTopic);

  if (isExplicitTopicShift(currentMessage, activeTopic)) {
    return fallbackWindow;
  }

  if (!followUp && !matchesTopic) {
    return fallbackWindow;
  }

  if (!activeTopic.anchorMessageId) {
    return fallbackWindow;
  }

  const anchorIndex = records.findIndex(
    (record) => record.id === activeTopic.anchorMessageId
  );

  if (anchorIndex < 0) {
    return fallbackWindow;
  }

  return records
    .slice(Math.max(0, anchorIndex - 2))
    .slice(-TOPIC_CONTEXT_MESSAGE_LIMIT)
    .map(toVoiceRecentMessage);
}

function toVoiceRecentMessage(
  record: VoiceRecentMessageRecordLike
): VoiceRecentMessageLike {
  return {
    role: record.role,
    content: record.content,
  };
}

function looksLikeTopicFollowUp(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return TOPIC_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function messageLikelyMatchesTopic(
  message: string,
  topic: VoiceTopicStateLike
): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if ((TOPIC_KEYWORD_MATCHES[topic.kind] ?? TOPIC_KEYWORD_MATCHES.general).test(normalized)) {
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

function inferMessageTopicKind(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const kind of TOPIC_ORDER) {
    if ((TOPIC_KEYWORD_MATCHES[kind] ?? TOPIC_KEYWORD_MATCHES.general).test(normalized)) {
      return kind;
    }
  }

  return null;
}

function isExplicitTopicShift(
  message: string,
  activeTopic: VoiceTopicStateLike | null
): boolean {
  if (!activeTopic || looksLikeTopicFollowUp(message)) {
    return false;
  }

  const hintedTopic = inferMessageTopicKind(message);
  if (!hintedTopic || hintedTopic === "general") {
    return false;
  }

  return hintedTopic !== activeTopic.kind;
}

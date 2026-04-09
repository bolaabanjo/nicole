import { getIntegrationAccount, getValidAccessToken } from "./oauth";

export interface GmailSearchResult {
  id: string;
  threadId: string | null;
  subject: string;
  summary: string | null;
  fromAddress: string | null;
  sender: string | null;
  receivedAt: string | null;
  status: string;
}

export interface GmailMessage {
  id: string;
  threadId: string | null;
  subject: string;
  fromAddress: string | null;
  sender: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  receivedAt: string | null;
  summary: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  status: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export interface GmailThread {
  provider: "gmail";
  threadId: string;
  subject: string | null;
  messageCount: number;
  messages: GmailMessage[];
}

export async function searchGmail(options: {
  query: string;
  limit?: number;
}) {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    return null;
  }

  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages"
  );
  listUrl.searchParams.set("q", options.query);
  listUrl.searchParams.set("maxResults", String(options.limit || 10));

  const listResponse = await fetch(listUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Gmail search failed: ${await listResponse.text()}`);
  }

  const listData = (await listResponse.json()) as {
    messages?: Array<{ id?: string; threadId?: string }>;
  };

  const messages = (listData.messages || []).filter(
    (message): message is { id: string; threadId?: string } =>
      typeof message.id === "string" && message.id.length > 0
  );

  if (messages.length === 0) {
    return [] satisfies GmailSearchResult[];
  }

  const results = await Promise.all(
    messages.map(async (message) => {
      const detail = await fetchGmailMessagePayload(message.id, "metadata", [
        "Subject",
        "From",
        "Date",
      ]);
      if (!detail) {
        return null;
      }

      const headers = detail.payload?.headers || [];
      const subject = findHeader(headers, "Subject");
      const from = findHeader(headers, "From");
      const date = findHeader(headers, "Date");

      if (!detail.id || !subject) {
        return null;
      }

      return {
        id: detail.id,
        threadId: detail.threadId || message.threadId || null,
        subject,
        summary: detail.snippet || null,
        fromAddress: parseSenderAddress(from),
        sender: parseSenderName(from),
        receivedAt: toIsoDateOrNull(date),
        status: detail.labelIds?.includes("UNREAD") ? "unread" : "read",
      } satisfies GmailSearchResult;
    })
  );

  return results.filter(
    (message): message is GmailSearchResult => Boolean(message)
  );
}

export async function readGmailMessage(input: { messageId: string }) {
  const detail = await fetchGmailMessagePayload(input.messageId, "full");
  if (!detail) {
    return null;
  }

  return parseGmailMessage(detail);
}

export async function readGmailThread(input: { threadId: string }) {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    return null;
  }

  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}`
  );
  url.searchParams.set("format", "full");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail thread read failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    id?: string;
    messages?: GmailApiMessage[];
  };

  const messages = (data.messages || [])
    .map(parseGmailMessage)
    .filter((message): message is GmailMessage => Boolean(message));

  return {
    provider: "gmail",
    threadId: data.id || input.threadId,
    subject: messages[0]?.subject || null,
    messageCount: messages.length,
    messages,
  } satisfies GmailThread;
}

export async function sendGmail(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string | null;
}) {
  const context = await getGmailContext();
  if (!context) {
    return null;
  }

  return sendGmailRawMessage(context.accessToken, {
    from: context.email,
    to: input.to,
    cc: input.cc || null,
    subject: input.subject,
    body: input.body,
  });
}

export async function sendGmailReply(input: {
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  cc?: string | null;
  messageIdHeader?: string | null;
  references?: string | null;
}) {
  const context = await getGmailContext();
  if (!context) {
    return null;
  }

  return sendGmailRawMessage(context.accessToken, {
    from: context.email,
    to: input.to,
    cc: input.cc || null,
    subject: ensureReplySubject(input.subject),
    body: input.body,
    threadId: input.threadId || null,
    inReplyTo: input.messageIdHeader || null,
    references: input.references || input.messageIdHeader || null,
  });
}

async function sendGmailRawMessage(
  accessToken: string,
  input: {
    from: string;
    to: string;
    subject: string;
    body: string;
    cc?: string | null;
    threadId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
  }
) {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    input.body,
  ];

  const raw = Buffer.from(headers.join("\r\n"), "utf8").toString("base64url");

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail send failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    id?: string;
    threadId?: string;
    labelIds?: string[];
  };

  return {
    sent: true,
    provider: "gmail",
    messageId: data.id || null,
    threadId: data.threadId || input.threadId || null,
    status: data.labelIds?.includes("SENT") ? "sent" : "queued",
  };
}

function parseGmailMessage(detail: GmailApiMessage): GmailMessage | null {
  if (!detail.id) {
    return null;
  }

  const headers = detail.payload?.headers || [];
  const from = findHeader(headers, "From");
  const to = findHeader(headers, "To");
  const cc = findHeader(headers, "Cc");
  const date = findHeader(headers, "Date");
  const subject = findHeader(headers, "Subject");
  const messageIdHeader = findHeader(headers, "Message-Id");
  const inReplyTo = findHeader(headers, "In-Reply-To");
  const references = findHeader(headers, "References");
  const bodyText = extractBodyPart(detail.payload, "text/plain");
  const bodyHtml = extractBodyPart(detail.payload, "text/html");

  return {
    id: detail.id,
    threadId: detail.threadId || null,
    subject: subject || "(no subject)",
    fromAddress: parseSenderAddress(from),
    sender: parseSenderName(from),
    toAddresses: parseAddressList(to),
    ccAddresses: parseAddressList(cc),
    receivedAt: toIsoDateOrNull(date),
    summary: detail.snippet || null,
    bodyText: bodyText || (bodyHtml ? stripHtml(bodyHtml) : null),
    bodyHtml,
    status: detail.labelIds?.includes("UNREAD") ? "unread" : "read",
    messageIdHeader,
    inReplyTo,
    references,
  };
}

async function fetchGmailMessagePayload(
  messageId: string,
  format: "metadata" | "full",
  metadataHeaders?: string[]
) {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    return null;
  }

  const detailUrl = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`
  );
  detailUrl.searchParams.set("format", format);
  for (const header of metadataHeaders || []) {
    detailUrl.searchParams.append("metadataHeaders", header);
  }

  const detailResponse = await fetch(detailUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!detailResponse.ok) {
    throw new Error(`Gmail message fetch failed: ${await detailResponse.text()}`);
  }

  return (await detailResponse.json()) as GmailApiMessage;
}

async function getGmailAccessToken() {
  return getValidAccessToken("gmail");
}

async function getGmailContext() {
  const account = await getIntegrationAccount("gmail");
  if (!account?.email) {
    return null;
  }

  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    return null;
  }

  return {
    email: account.email,
    accessToken,
  };
}

interface GmailApiMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailApiPayload;
}

interface GmailApiPayload {
  mimeType?: string;
  body?: { data?: string; size?: number };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailApiPayload[];
}

function findHeader(
  headers: Array<{ name?: string; value?: string }>,
  name: string
) {
  return (
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())
      ?.value || null
  );
}

function parseSenderName(value: string | null) {
  if (!value) {
    return null;
  }

  const match = value.match(/^(.*?)\s*<[^>]+>$/);
  if (!match) {
    return null;
  }

  const cleaned = match[1].trim().replace(/^"|"$/g, "");
  return cleaned || null;
}

function parseSenderAddress(value: string | null) {
  if (!value) {
    return null;
  }

  const angleMatch = value.match(/<([^>]+)>/);
  if (angleMatch) {
    return angleMatch[1].trim();
  }

  const bareEmailMatch = value.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );
  return bareEmailMatch ? bareEmailMatch[0] : null;
}

function parseAddressList(value: string | null) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => parseSenderAddress(entry) || entry.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function extractBodyPart(
  payload: GmailApiPayload | undefined,
  mimeType: "text/plain" | "text/html"
): string | null {
  if (!payload) {
    return null;
  }

  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts || []) {
    const nested = extractBodyPart(part, mimeType);
    if (nested) {
      return nested;
    }
  }

  if (
    mimeType === "text/plain" &&
    payload.mimeType === "multipart/alternative" &&
    payload.body?.data
  ) {
    return decodeBase64Url(payload.body.data);
  }

  return null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function toIsoDateOrNull(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureReplySubject(value: string) {
  return /^re:/i.test(value.trim()) ? value.trim() : `Re: ${value.trim()}`;
}

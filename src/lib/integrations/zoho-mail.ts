import { getIntegrationAccount, getValidAccessToken } from "./oauth";

export interface ZohoMailSearchResult {
  id: string;
  folderId: string | null;
  threadId: string | null;
  subject: string;
  summary: string | null;
  fromAddress: string | null;
  sender: string | null;
  receivedAt: string | null;
  status: string | null;
}

export interface ZohoMailMessage {
  id: string;
  folderId: string | null;
  threadId: string | null;
  subject: string;
  fromAddress: string | null;
  sender: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  receivedAt: string | null;
  summary: string | null;
  bodyText: string | null;
  status: string | null;
  messageIdHeader: string | null;
  references: string | null;
  inReplyTo: string | null;
}

export interface ZohoMailThread {
  provider: "zoho_mail";
  threadId: string | null;
  messageCount: number;
  messages: ZohoMailMessage[];
  note?: string | null;
}

export async function searchZohoMail(options: {
  query: string;
  limit?: number;
}) {
  const context = await getZohoMailContext();
  if (!context) {
    return null;
  }

  const url = new URL(
    `https://mail.zoho.com/api/accounts/${context.accountId}/messages/search`
  );
  url.searchParams.set("searchKey", options.query);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", String(options.limit || 10));
  url.searchParams.set("includeto", "true");

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${context.accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Zoho Mail search failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    data?: Array<{
      messageId?: string | number;
      folderId?: string | number;
      threadId?: string | number;
      conversationId?: string | number;
      subject?: string;
      summary?: string;
      fromAddress?: string;
      sender?: string;
      status?: string;
      receivedtime?: number;
    }>;
  };

  return (data.data || [])
    .map((message) => {
      if (!message.messageId || !message.subject) {
        return null;
      }

      return {
        id: String(message.messageId),
        folderId: stringifyMaybe(message.folderId),
        threadId:
          stringifyMaybe(message.threadId) ||
          stringifyMaybe(message.conversationId) ||
          null,
        subject: message.subject,
        summary: message.summary || null,
        fromAddress: message.fromAddress || null,
        sender: message.sender || null,
        receivedAt: message.receivedtime
          ? new Date(Number(message.receivedtime)).toISOString()
          : null,
        status: message.status || null,
      } satisfies ZohoMailSearchResult;
    })
    .filter((message): message is ZohoMailSearchResult => Boolean(message));
}

export async function readZohoMailMessage(input: {
  messageId: string;
  folderId?: string | null;
}) {
  const context = await getZohoMailContext();
  if (!context) {
    return null;
  }

  const headers = await fetchZohoHeaders(
    context,
    input.messageId,
    input.folderId || null
  );
  const content = await fetchZohoContent(
    context,
    input.messageId,
    input.folderId || null
  );
  const original = !content
    ? await fetchZohoOriginalMessage(context, input.messageId)
    : null;

  return buildZohoMessage({
    messageId: input.messageId,
    folderId: input.folderId || null,
    headers,
    content,
    originalRaw: original,
  });
}

export async function readZohoMailThread(input: {
  messageId: string;
  folderId?: string | null;
}) {
  const context = await getZohoMailContext();
  if (!context) {
    return null;
  }

  if (!input.folderId) {
    const single = await readZohoMailMessage(input);
    if (!single) {
      return null;
    }

    return {
      provider: "zoho_mail",
      threadId: single.threadId,
      messageCount: 1,
      messages: [single],
      note:
        "Zoho thread expansion needs folder metadata. I only loaded the selected message.",
    } satisfies ZohoMailThread;
  }

  const content = await fetchZohoContent(
    context,
    input.messageId,
    input.folderId,
    true
  );

  if (!content) {
    const single = await readZohoMailMessage(input);
    if (!single) {
      return null;
    }

    return {
      provider: "zoho_mail",
      threadId: single.threadId,
      messageCount: 1,
      messages: [single],
      note:
        "Zoho did not return expanded thread blocks, so I loaded the selected message only.",
    } satisfies ZohoMailThread;
  }

  const blocks = extractZohoThreadBlocks(content);
  if (blocks.length === 0) {
    const single = await readZohoMailMessage(input);
    if (!single) {
      return null;
    }

    return {
      provider: "zoho_mail",
      threadId: single.threadId,
      messageCount: 1,
      messages: [single],
      note:
        "Zoho returned content but no distinct thread blocks, so I loaded the selected message only.",
    } satisfies ZohoMailThread;
  }

  const messages = blocks.map((block) =>
    buildZohoMessage({
      messageId: block.messageId || input.messageId,
      folderId: input.folderId || null,
      headers: block.headers || null,
      content: block,
      originalRaw: null,
    })
  );

  const filtered = messages.filter(
    (message): message is ZohoMailMessage => Boolean(message)
  );

  return {
    provider: "zoho_mail",
    threadId: filtered[0]?.threadId || null,
    messageCount: filtered.length,
    messages: filtered,
  } satisfies ZohoMailThread;
}

export async function sendZohoMail(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string | null;
}) {
  const context = await getZohoMailContext();
  if (!context) {
    return null;
  }

  const response = await fetch(
    `https://mail.zoho.com/api/accounts/${context.accountId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${context.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fromAddress: context.email,
        toAddress: input.to,
        ccAddress: input.cc || undefined,
        subject: input.subject,
        content: input.body,
        mailFormat: "plaintext",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Zoho Mail send failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    status?: { code?: number; description?: string };
    data?: { messageId?: string | number };
  };

  return {
    sent: true,
    provider: "zoho_mail",
    messageId: data.data?.messageId ? String(data.data.messageId) : null,
    status: data.status?.description || "sent",
  };
}

export async function sendZohoMailReply(input: {
  originalMessageId: string;
  to: string;
  subject: string;
  body: string;
  cc?: string | null;
}) {
  const context = await getZohoMailContext();
  if (!context) {
    return null;
  }

  const response = await fetch(
    `https://mail.zoho.com/api/accounts/${context.accountId}/messages/${input.originalMessageId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${context.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "reply",
        fromAddress: context.email,
        toAddress: input.to,
        ccAddress: input.cc || undefined,
        subject: ensureReplySubject(input.subject),
        content: input.body,
        mailFormat: "plaintext",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Zoho Mail reply failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    status?: { code?: number; description?: string };
    data?: { messageId?: string | number };
  };

  return {
    sent: true,
    provider: "zoho_mail",
    messageId: data.data?.messageId ? String(data.data.messageId) : null,
    status: data.status?.description || "sent",
  };
}

async function getZohoMailContext() {
  const account = await getIntegrationAccount("zoho_mail");
  if (!account?.externalAccountId || !account.email) {
    return null;
  }

  const accessToken = await getValidAccessToken("zoho_mail");
  if (!accessToken) {
    return null;
  }

  return {
    accountId: account.externalAccountId,
    email: account.email,
    accessToken,
  };
}

async function fetchZohoHeaders(
  context: Awaited<ReturnType<typeof getZohoMailContext>>,
  messageId: string,
  folderId: string | null
) {
  if (!context || !folderId) {
    return null;
  }

  const response = await fetch(
    `https://mail.zoho.com/api/accounts/${context.accountId}/folders/${folderId}/messages/${messageId}/details`,
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${context.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as Record<string, unknown>;
}

async function fetchZohoContent(
  context: Awaited<ReturnType<typeof getZohoMailContext>>,
  messageId: string,
  folderId: string | null,
  includeBlockContent = false
) {
  if (!context || !folderId) {
    return null;
  }

  const url = new URL(
    `https://mail.zoho.com/api/accounts/${context.accountId}/folders/${folderId}/messages/${messageId}/content`
  );
  if (includeBlockContent) {
    url.searchParams.set("includeBlockContent", "true");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${context.accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as Record<string, unknown>;
}

async function fetchZohoOriginalMessage(
  context: Awaited<ReturnType<typeof getZohoMailContext>>,
  messageId: string
) {
  if (!context) {
    return null;
  }

  const response = await fetch(
    `https://mail.zoho.com/api/accounts/${context.accountId}/messages/${messageId}/originalmessage`,
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${context.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  return response.text();
}

function buildZohoMessage(input: {
  messageId: string;
  folderId: string | null;
  headers: Record<string, unknown> | null;
  content: Record<string, unknown> | null;
  originalRaw: string | null;
}) {
  const headerBag = extractZohoHeaderMap(input.headers, input.originalRaw);
  const contentText =
    extractZohoContentText(input.content) || extractRawEmailBody(input.originalRaw);
  const threadId =
    findNestedString(input.headers, ["data", "threadId"]) ||
    findNestedString(input.headers, ["data", "conversationId"]) ||
    findNestedString(input.content, ["data", "threadId"]) ||
    null;

  return {
    id: input.messageId,
    folderId: input.folderId,
    threadId,
    subject: headerBag.subject || "(no subject)",
    fromAddress: parseAddress(headerBag.from),
    sender: parseDisplayName(headerBag.from),
    toAddresses: splitAddresses(headerBag.to),
    ccAddresses: splitAddresses(headerBag.cc),
    receivedAt: toIsoDateOrNull(headerBag.date),
    summary: contentText ? contentText.slice(0, 280) : null,
    bodyText: contentText,
    status:
      findNestedString(input.headers, ["data", "status"]) ||
      findNestedString(input.content, ["data", "status"]) ||
      null,
    messageIdHeader: headerBag.messageId,
    references: headerBag.references,
    inReplyTo: headerBag.inReplyTo,
  } satisfies ZohoMailMessage;
}

function extractZohoThreadBlocks(content: Record<string, unknown>) {
  const candidates = [
    findNestedArray(content, ["data", "blockContent"]),
    findNestedArray(content, ["data", "blocks"]),
    findNestedArray(content, ["blockContent"]),
    findNestedArray(content, ["blocks"]),
  ].filter((value): value is unknown[] => Array.isArray(value));

  const blocks = candidates[0] || [];
  return blocks
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      messageId:
        stringifyMaybe(item.messageId) || stringifyMaybe(item.blockId) || null,
      headers: (item.headers as Record<string, unknown> | undefined) || null,
      ...item,
    }));
}

function extractZohoHeaderMap(
  payload: Record<string, unknown> | null,
  raw: string | null
) {
  const fromPayload = {
    subject:
      findNestedString(payload, ["data", "subject"]) ||
      findNestedString(payload, ["subject"]),
    from:
      findNestedString(payload, ["data", "fromAddress"]) ||
      findNestedString(payload, ["data", "from"]) ||
      findNestedString(payload, ["fromAddress"]),
    to:
      findNestedString(payload, ["data", "toAddress"]) ||
      findNestedString(payload, ["data", "to"]) ||
      findNestedString(payload, ["toAddress"]),
    cc:
      findNestedString(payload, ["data", "ccAddress"]) ||
      findNestedString(payload, ["data", "cc"]) ||
      findNestedString(payload, ["ccAddress"]),
    date:
      findNestedString(payload, ["data", "date"]) ||
      findNestedString(payload, ["data", "receivedTime"]),
    messageId:
      findNestedString(payload, ["data", "messageIdHeader"]) ||
      findNestedString(payload, ["data", "messageId"]),
    references:
      findNestedString(payload, ["data", "references"]) ||
      findNestedString(payload, ["references"]),
    inReplyTo:
      findNestedString(payload, ["data", "inReplyTo"]) ||
      findNestedString(payload, ["inReplyTo"]),
  };

  const fromRaw = parseRawEmailHeaders(raw);

  return {
    subject: fromPayload.subject || fromRaw.subject,
    from: fromPayload.from || fromRaw.from,
    to: fromPayload.to || fromRaw.to,
    cc: fromPayload.cc || fromRaw.cc,
    date: fromPayload.date || fromRaw.date,
    messageId: fromPayload.messageId || fromRaw.messageId,
    references: fromPayload.references || fromRaw.references,
    inReplyTo: fromPayload.inReplyTo || fromRaw.inReplyTo,
  };
}

function parseRawEmailHeaders(raw: string | null) {
  if (!raw) {
    return {
      subject: null,
      from: null,
      to: null,
      cc: null,
      date: null,
      messageId: null,
      references: null,
      inReplyTo: null,
    };
  }

  const headerText = raw.split(/\r?\n\r?\n/)[0] || "";
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r?\n/);
  const map = new Map<string, string>();

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map.set(key, value);
  }

  return {
    subject: map.get("subject") || null,
    from: map.get("from") || null,
    to: map.get("to") || null,
    cc: map.get("cc") || null,
    date: map.get("date") || null,
    messageId: map.get("message-id") || null,
    references: map.get("references") || null,
    inReplyTo: map.get("in-reply-to") || null,
  };
}

function extractRawEmailBody(raw: string | null) {
  if (!raw) {
    return null;
  }

  const body = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
  if (!body) {
    return null;
  }

  return body
    .replace(/Content-Type:[^\n]+\n/gi, "")
    .replace(/Content-Transfer-Encoding:[^\n]+\n/gi, "")
    .replace(/--[A-Za-z0-9'()+_,\-./:=? ]+/g, " ")
    .replace(/=\r?\n/g, "")
    .replace(/=\w\w/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractZohoContentText(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }

  const candidate =
    findNestedString(payload, ["data", "content"]) ||
    findNestedString(payload, ["data", "textContent"]) ||
    findNestedString(payload, ["content"]) ||
    null;

  if (!candidate) {
    return null;
  }

  return stripHtml(candidate);
}

function findNestedString(
  value: Record<string, unknown> | null,
  path: string[]
): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim().length > 0
    ? current.trim()
    : null;
}

function findNestedArray(
  value: Record<string, unknown> | null,
  path: string[]
) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return Array.isArray(current) ? current : null;
}

function splitAddresses(value: string | null) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => parseAddress(entry) || entry.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function parseDisplayName(value: string | null) {
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

function parseAddress(value: string | null) {
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

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDateOrNull(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stringifyMaybe(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return null;
}

function ensureReplySubject(value: string) {
  return /^re:/i.test(value.trim()) ? value.trim() : `Re: ${value.trim()}`;
}

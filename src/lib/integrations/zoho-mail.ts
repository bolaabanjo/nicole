import { getIntegrationAccount, getValidAccessToken } from "./oauth";

export interface ZohoMailSearchResult {
  id: string;
  subject: string;
  summary: string | null;
  fromAddress: string | null;
  sender: string | null;
  receivedAt: string | null;
  status: string | null;
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

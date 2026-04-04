export type IntegrationProviderId =
  | "google_calendar"
  | "zoho_mail"
  | "apple_calendar"
  | "apple_reminders";

export type IntegrationKind = "calendar" | "email" | "reminders";
export type IntegrationConnectionType = "oauth" | "native_mac";

export interface IntegrationProviderDefinition {
  id: IntegrationProviderId;
  kind: IntegrationKind;
  title: string;
  description: string;
  connectionType: IntegrationConnectionType;
  status: "ready" | "planned";
  capabilities: string[];
}

export const INTEGRATION_PROVIDERS: IntegrationProviderDefinition[] = [
  {
    id: "google_calendar",
    kind: "calendar",
    title: "Google Calendar",
    description:
      "Use your real Google Calendar for upcoming events, availability checks, and scheduling.",
    connectionType: "oauth",
    status: "ready",
    capabilities: ["calendar_read", "calendar_create_event"],
  },
  {
    id: "zoho_mail",
    kind: "email",
    title: "Zoho Mail",
    description:
      "Connect Zoho Mail so Nicole can eventually read, search, and send email from Banjo.",
    connectionType: "oauth",
    status: "ready",
    capabilities: ["email_search", "email_send"],
  },
  {
    id: "apple_calendar",
    kind: "calendar",
    title: "Apple Calendar",
    description:
      "Mac-local calendar access through NicoleMacOS. Best for native Apple workflows and permissions.",
    connectionType: "native_mac",
    status: "planned",
    capabilities: ["calendar_read", "calendar_create_event"],
  },
  {
    id: "apple_reminders",
    kind: "reminders",
    title: "Apple Reminders",
    description:
      "Mac-local reminders integration through NicoleMacOS once the native bridge is wired.",
    connectionType: "native_mac",
    status: "planned",
    capabilities: ["reminder_create"],
  },
];

export function getIntegrationProvider(
  id: string
): IntegrationProviderDefinition | null {
  return INTEGRATION_PROVIDERS.find((provider) => provider.id === id) || null;
}

export function isProviderConfigured(id: IntegrationProviderId): boolean {
  switch (id) {
    case "google_calendar":
      return Boolean(
        process.env.GOOGLE_CLIENT_ID?.trim() &&
          process.env.GOOGLE_CLIENT_SECRET?.trim()
      );
    case "zoho_mail":
      return Boolean(
        process.env.ZOHO_CLIENT_ID?.trim() &&
          process.env.ZOHO_CLIENT_SECRET?.trim()
      );
    case "apple_calendar":
    case "apple_reminders":
      return true;
  }
}

export function getProviderScopes(id: IntegrationProviderId): string[] {
  switch (id) {
    case "google_calendar":
      return [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar",
      ];
    case "zoho_mail":
      return [
        "ZohoMail.messages.READ",
        "ZohoMail.messages.CREATE",
        "ZohoMail.accounts.READ",
      ];
    case "apple_calendar":
    case "apple_reminders":
      return [];
  }
}

import { getValidAccessToken } from "./oauth";

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  htmlLink: string | null;
}

export async function listGoogleCalendarEvents(options?: {
  start?: string;
  end?: string;
  limit?: number;
}) {
  const accessToken = await getValidAccessToken("google_calendar");
  if (!accessToken) {
    return null;
  }

  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events"
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(options?.limit || 12));
  url.searchParams.set("timeMin", options?.start || new Date().toISOString());
  if (options?.end) {
    url.searchParams.set("timeMax", options.end);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google Calendar read failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      description?: string;
      location?: string;
      htmlLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };

  return (data.items || [])
    .map((item) => {
      const startAt = item.start?.dateTime || item.start?.date;
      const endAt = item.end?.dateTime || item.end?.date;

      if (!item.id || !item.summary || !startAt || !endAt) {
        return null;
      }

      return {
        id: item.id,
        title: item.summary,
        description: item.description || null,
        location: item.location || null,
        startAt,
        endAt,
        htmlLink: item.htmlLink || null,
      } satisfies GoogleCalendarEvent;
    })
    .filter((event): event is GoogleCalendarEvent => Boolean(event));
}

export async function createGoogleCalendarEvent(input: {
  title: string;
  start: string;
  end: string;
  description?: string | null;
  location?: string | null;
}) {
  const accessToken = await getValidAccessToken("google_calendar");
  if (!accessToken) {
    return null;
  }

  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.title,
        description: input.description || undefined,
        location: input.location || undefined,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Google Calendar create failed: ${await response.text()}`);
  }

  const event = (await response.json()) as {
    id?: string;
    summary?: string;
    description?: string;
    location?: string;
    htmlLink?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  };

  return {
    id: event.id || crypto.randomUUID(),
    title: event.summary || input.title,
    description: event.description || null,
    location: event.location || null,
    startAt: event.start?.dateTime || event.start?.date || input.start,
    endAt: event.end?.dateTime || event.end?.date || input.end,
    htmlLink: event.htmlLink || null,
  } satisfies GoogleCalendarEvent;
}

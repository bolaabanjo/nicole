import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { and, eq, lte, isNotNull, or, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { reminders } from "@/lib/db/schema";
import { listGoogleCalendarEvents } from "@/lib/integrations/google-calendar";
import { chat } from "@/lib/ai/router";
import { ChatMessage } from "@/lib/ai/types";
import { readWorkspaceFile } from "@/lib/ai/workspace";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NudgePriority = "low" | "medium" | "high" | "urgent";

export interface HeartbeatSignal {
  check: string;
  priority: NudgePriority;
  summary: string;
  detail: string;
}

export interface HeartbeatNudge {
  id: string;
  message: string;
  priority: NudgePriority;
  speakable: boolean;
  signals: string[];
  timestamp: string;
}

export interface HeartbeatResult {
  nudge: HeartbeatNudge | null;
  signals: HeartbeatSignal[];
  skippedReason: string | null;
}

interface HeartbeatState {
  lastCheckTimes: Record<string, number>;
  lastNudgeTime: number;
  deliveredNudgeIds: string[];
  lastMorningBriefingDate: string | null;
  screenTimeTracker: {
    currentApp: string | null;
    appStartTime: number | null;
    totalMinutes: number;
  };
}

interface HeartbeatConfig {
  enabled: boolean;
  pollIntervalMinutes: number;
  maxNudgesPerHour: number;
  cooldownMinutes: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  overrideForUrgent: boolean;
  checks: {
    calendar: { enabled: boolean; intervalMinutes: number; warnBeforeMinutes: number };
    reminders: { enabled: boolean; intervalMinutes: number };
    screenTime: { enabled: boolean; intervalMinutes: number; warnAfterMinutes: number };
    timeAwareness: { enabled: boolean; intervalMinutes: number; lateNightAfter: string };
    email: { enabled: boolean; intervalMinutes: number };
    weather: { enabled: boolean; intervalMinutes: number; location?: string };
    health: { enabled: boolean; intervalMinutes: number };
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = join(homedir(), ".nicole");
const STATE_PATH = join(WORKSPACE_DIR, "heartbeat_state.json");

// ---------------------------------------------------------------------------
// Config (parsed from HEARTBEAT.md / heartbeat.md structure, with defaults)
// ---------------------------------------------------------------------------

function defaultConfig(): HeartbeatConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    maxNudgesPerHour: 4,
    cooldownMinutes: 10,
    quietHoursStart: "23:30",
    quietHoursEnd: "07:00",
    overrideForUrgent: true,
    checks: {
      calendar: { enabled: true, intervalMinutes: 5, warnBeforeMinutes: 30 },
      reminders: { enabled: true, intervalMinutes: 10 },
      screenTime: { enabled: true, intervalMinutes: 15, warnAfterMinutes: 120 },
      timeAwareness: { enabled: true, intervalMinutes: 30, lateNightAfter: "01:00" },
      email: { enabled: false, intervalMinutes: 30 },
      weather: { enabled: true, intervalMinutes: 60 },
      health: { enabled: true, intervalMinutes: 30 },
    },
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = stripQuotes(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(stripQuotes(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseString(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = stripQuotes(value);
  return parsed || fallback;
}

function parseHeartbeatSections(markdown: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let currentH2 = "";
  let currentH3 = "";

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      currentH3 = h3Match[1].trim();
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      currentH2 = h2Match[1].trim();
      currentH3 = "";
      continue;
    }

    const keyValueMatch = line.match(/^-\s*([a-zA-Z0-9_]+):\s*(.+)$/);
    if (!keyValueMatch) {
      continue;
    }

    const sectionKey = currentH3 ? `${currentH2}/${currentH3}` : currentH2;
    if (!sectionKey) {
      continue;
    }

    sections[sectionKey] ??= {};
    sections[sectionKey][keyValueMatch[1]] = keyValueMatch[2].trim();
  }

  return sections;
}

async function loadConfig(): Promise<HeartbeatConfig> {
  const config = defaultConfig();
  const markdown = await readWorkspaceFile("HEARTBEAT.md");

  if (!markdown?.trim()) {
    return config;
  }

  const sections = parseHeartbeatSections(markdown);
  const settings = sections["Settings"] || {};
  const quietHours = sections["Quiet Hours"] || {};
  const calendar = sections["Checks/calendar"] || {};
  const remindersSection = sections["Checks/reminders"] || {};
  const screenTime = sections["Checks/screen_time"] || {};
  const timeAwareness = sections["Checks/time_awareness"] || {};
  const email = sections["Checks/email"] || {};
  const weatherSection = sections["Checks/weather"] || {};
  const healthSection = sections["Checks/health"] || {};

  config.enabled = parseBoolean(settings.enabled, config.enabled);
  config.pollIntervalMinutes = parseNumber(
    settings.poll_interval_minutes,
    config.pollIntervalMinutes
  );
  config.maxNudgesPerHour = parseNumber(
    settings.max_nudges_per_hour,
    config.maxNudgesPerHour
  );
  config.cooldownMinutes = parseNumber(
    settings.cooldown_minutes,
    config.cooldownMinutes
  );

  config.quietHoursStart = parseString(
    quietHours.start,
    config.quietHoursStart
  );
  config.quietHoursEnd = parseString(
    quietHours.end,
    config.quietHoursEnd
  );
  config.overrideForUrgent = parseBoolean(
    quietHours.override_for_urgent,
    config.overrideForUrgent
  );

  config.checks.calendar.enabled = parseBoolean(
    calendar.enabled,
    config.checks.calendar.enabled
  );
  config.checks.calendar.intervalMinutes = parseNumber(
    calendar.interval_minutes,
    config.checks.calendar.intervalMinutes
  );
  config.checks.calendar.warnBeforeMinutes = parseNumber(
    calendar.warn_before_minutes,
    config.checks.calendar.warnBeforeMinutes
  );

  config.checks.reminders.enabled = parseBoolean(
    remindersSection.enabled,
    config.checks.reminders.enabled
  );
  config.checks.reminders.intervalMinutes = parseNumber(
    remindersSection.interval_minutes,
    config.checks.reminders.intervalMinutes
  );

  config.checks.screenTime.enabled = parseBoolean(
    screenTime.enabled,
    config.checks.screenTime.enabled
  );
  config.checks.screenTime.intervalMinutes = parseNumber(
    screenTime.interval_minutes,
    config.checks.screenTime.intervalMinutes
  );
  config.checks.screenTime.warnAfterMinutes = parseNumber(
    screenTime.warn_after_minutes,
    config.checks.screenTime.warnAfterMinutes
  );

  config.checks.timeAwareness.enabled = parseBoolean(
    timeAwareness.enabled,
    config.checks.timeAwareness.enabled
  );
  config.checks.timeAwareness.intervalMinutes = parseNumber(
    timeAwareness.interval_minutes,
    config.checks.timeAwareness.intervalMinutes
  );
  config.checks.timeAwareness.lateNightAfter = parseString(
    timeAwareness.late_night_after,
    config.checks.timeAwareness.lateNightAfter
  );

  config.checks.email.enabled = parseBoolean(
    email.enabled,
    config.checks.email.enabled
  );
  config.checks.email.intervalMinutes = parseNumber(
    email.interval_minutes,
    config.checks.email.intervalMinutes
  );

  config.checks.weather.enabled = parseBoolean(
    weatherSection.enabled,
    config.checks.weather.enabled
  );
  config.checks.weather.intervalMinutes = parseNumber(
    weatherSection.interval_minutes,
    config.checks.weather.intervalMinutes
  );
  if (weatherSection.location) {
    config.checks.weather.location = stripQuotes(weatherSection.location);
  }

  config.checks.health.enabled = parseBoolean(
    healthSection.enabled,
    config.checks.health.enabled
  );
  config.checks.health.intervalMinutes = parseNumber(
    healthSection.interval_minutes,
    config.checks.health.intervalMinutes
  );

  return config;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function defaultState(): HeartbeatState {
  return {
    lastCheckTimes: {},
    lastNudgeTime: 0,
    deliveredNudgeIds: [],
    lastMorningBriefingDate: null,
    screenTimeTracker: {
      currentApp: null,
      appStartTime: null,
      totalMinutes: 0,
    },
  };
}

async function loadState(): Promise<HeartbeatState> {
  try {
    if (!existsSync(STATE_PATH)) return defaultState();
    const raw = await readFile(STATE_PATH, "utf-8");
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

async function saveState(state: HeartbeatState): Promise<void> {
  try {
    // Keep delivered list from growing forever — only last 100
    state.deliveredNudgeIds = state.deliveredNudgeIds.slice(-100);
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

function minutesSince(timestampMs: number): number {
  return (nowMs() - timestampMs) / 60_000;
}

function isQuietHours(start: string, end: string): boolean {
  const now = new Date();
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes > endMinutes) {
    // Spans midnight (e.g. 23:30 → 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function shouldRunCheck(
  checkName: string,
  intervalMinutes: number,
  state: HeartbeatState
): boolean {
  const lastRun = state.lastCheckTimes[checkName] || 0;
  return minutesSince(lastRun) >= intervalMinutes;
}

function formatTimeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);

  if (diffMin <= 0) return "now";
  if (diffMin === 1) return "1 minute";
  if (diffMin < 60) return `${diffMin} minutes`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (mins === 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
  return `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkCalendar(
  config: HeartbeatConfig["checks"]["calendar"]
): Promise<HeartbeatSignal[]> {
  const signals: HeartbeatSignal[] = [];

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + config.warnBeforeMinutes * 60_000);

    const events = await listGoogleCalendarEvents({
      start: now.toISOString(),
      end: windowEnd.toISOString(),
      limit: 5,
    });

    if (!events || events.length === 0) return signals;

    for (const event of events) {
      const startDate = new Date(event.startAt);
      const minutesAway = Math.round(
        (startDate.getTime() - now.getTime()) / 60_000
      );

      if (minutesAway < 0) continue; // Already started

      let priority: NudgePriority = "medium";
      if (minutesAway <= 5) priority = "high";
      else if (minutesAway <= 10) priority = "high";

      const timeStr = formatTimeUntil(startDate);
      const location = event.location ? ` at ${event.location}` : "";

      signals.push({
        check: "calendar",
        priority,
        summary: `"${event.title}" in ${timeStr}${location}`,
        detail: `Calendar event "${event.title}" starts in ${timeStr}.${location ? ` Location: ${event.location}.` : ""}${event.description ? ` Notes: ${event.description}` : ""}`,
      });
    }
  } catch (error) {
    console.error("Heartbeat calendar check failed:", error);
  }

  return signals;
}

async function checkReminders(): Promise<HeartbeatSignal[]> {
  const signals: HeartbeatSignal[] = [];

  try {
    const now = new Date();

    // Pending reminders that are due or overdue
    const dueReminders = await db
      .select({
        id: reminders.id,
        title: reminders.title,
        notes: reminders.notes,
        dueAt: reminders.dueAt,
      })
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "pending"),
          isNotNull(reminders.dueAt),
          lte(reminders.dueAt, new Date(now.getTime() + 30 * 60_000))
        )
      )
      .limit(5);

    for (const reminder of dueReminders) {
      if (!reminder.dueAt) continue;

      const isOverdue = reminder.dueAt.getTime() < now.getTime();
      const priority: NudgePriority = isOverdue ? "high" : "medium";
      const timeLabel = isOverdue
        ? `overdue by ${formatTimeUntil(new Date(2 * now.getTime() - reminder.dueAt.getTime()))}`
        : `due in ${formatTimeUntil(reminder.dueAt)}`;

      signals.push({
        check: "reminders",
        priority,
        summary: `Reminder: "${reminder.title}" — ${timeLabel}`,
        detail: `${isOverdue ? "Overdue" : "Upcoming"} reminder: "${reminder.title}" (${timeLabel}).${reminder.notes ? ` Notes: ${reminder.notes}` : ""}`,
      });
    }
  } catch (error) {
    console.error("Heartbeat reminders check failed:", error);
  }

  return signals;
}

function checkScreenTime(
  state: HeartbeatState,
  config: HeartbeatConfig["checks"]["screenTime"],
  activeApp?: string | null
): HeartbeatSignal[] {
  const signals: HeartbeatSignal[] = [];
  const tracker = state.screenTimeTracker;
  const now = nowMs();

  if (activeApp && activeApp !== "Nicole") {
    if (tracker.currentApp === activeApp && tracker.appStartTime) {
      const minutes = (now - tracker.appStartTime) / 60_000;
      if (minutes >= config.warnAfterMinutes) {
        signals.push({
          check: "screen_time",
          priority: "low",
          summary: `You've been in ${activeApp} for ${Math.round(minutes)} minutes straight`,
          detail: `Continuous usage of "${activeApp}" for ${Math.round(minutes)} minutes. Consider a break.`,
        });
      }
    } else {
      // App changed — reset tracker
      tracker.currentApp = activeApp;
      tracker.appStartTime = now;
    }
  }

  return signals;
}

function checkTimeAwareness(
  config: HeartbeatConfig["checks"]["timeAwareness"]
): HeartbeatSignal[] {
  const signals: HeartbeatSignal[] = [];
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  const [lateH, lateM] = config.lateNightAfter.split(":").map(Number);
  const currentMinutes = hour * 60 + minute;
  const lateMinutes = lateH * 60 + lateM;

  // Late night check (between lateNightAfter and 05:00)
  if (currentMinutes >= lateMinutes || (hour >= 0 && hour < 5)) {
    signals.push({
      check: "time_awareness",
      priority: "low",
      summary: `It's ${hour}:${minute.toString().padStart(2, "0")}`,
      detail: `It's ${hour}:${minute.toString().padStart(2, "0")}. Late night session detected.`,
    });
  }

  return signals;
}

async function checkWeather(
  location?: string
): Promise<HeartbeatSignal[]> {
  try {
    const { checkWeatherForHeartbeat } = await import("@/lib/integrations/weather");
    const result = await checkWeatherForHeartbeat(location);
    if (!result || !result.shouldAlert) return [];

    return [{
      check: "weather",
      priority: "medium",
      summary: result.summary,
      detail: result.summary,
    }];
  } catch (error) {
    console.error("Heartbeat weather check failed:", error);
    return [];
  }
}

async function checkHealth(): Promise<HeartbeatSignal[]> {
  try {
    const { checkHealthForHeartbeat } = await import("@/lib/integrations/health");
    const result = await checkHealthForHeartbeat();
    if (!result || !result.shouldAlert) return [];

    return [{
      check: "health",
      priority: "medium",
      summary: result.summary,
      detail: result.summary,
    }];
  } catch (error) {
    console.error("Heartbeat health check failed:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Morning briefing — proactive daily kickoff
// ---------------------------------------------------------------------------

function shouldDeliverMorningBriefing(state: HeartbeatState, config: HeartbeatConfig): boolean {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Already delivered today
  if (state.lastMorningBriefingDate === today) return false;

  // Only deliver after quiet hours end (e.g. after 07:00)
  const [endH, endM] = config.quietHoursEnd.split(":").map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const endMinutes = endH * 60 + endM;

  // Deliver between quiet hours end and 2 hours after (e.g. 07:00–09:00)
  return currentMinutes >= endMinutes && currentMinutes <= endMinutes + 120;
}

async function buildMorningBriefing(
  config: HeartbeatConfig
): Promise<HeartbeatSignal[]> {
  const signals: HeartbeatSignal[] = [];
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "morning" : "afternoon";

  // Weather
  try {
    const { getWeather } = await import("@/lib/integrations/weather");
    const weather = await getWeather(config.checks.weather.location, 1);
    const { current, forecast } = weather;

    let weatherSummary = `It's ${current.temperature}°C and ${current.weatherDescription.toLowerCase()} in ${current.location}.`;
    if (current.feelsLike !== current.temperature) {
      weatherSummary += ` Feels like ${current.feelsLike}°C.`;
    }

    // Check forecast for rain/snow later
    if (forecast.length > 0) {
      const today = forecast[0];
      if (today.precipitationProbability > 40) {
        weatherSummary += ` ${today.precipitationProbability}% chance of rain today — might want an umbrella.`;
      }
      weatherSummary += ` High of ${today.temperatureMax}°C, low of ${today.temperatureMin}°C.`;
    }

    signals.push({
      check: "morning_briefing",
      priority: "medium",
      summary: weatherSummary,
      detail: weatherSummary,
    });
  } catch {
    // Weather unavailable — briefing continues without it
  }

  // Calendar — today's events
  try {
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const events = await listGoogleCalendarEvents({
      start: now.toISOString(),
      end: todayEnd.toISOString(),
      limit: 5,
    });

    if (events && events.length > 0) {
      const eventSummaries = events.map((e) => {
        const time = new Date(e.startAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `${e.title} at ${time}`;
      });
      signals.push({
        check: "morning_briefing",
        priority: "medium",
        summary: `Today's schedule: ${eventSummaries.join(", ")}.`,
        detail: `Calendar events today: ${eventSummaries.join("; ")}.`,
      });
    } else {
      signals.push({
        check: "morning_briefing",
        priority: "low",
        summary: "No events on the calendar today.",
        detail: "Calendar is clear for today.",
      });
    }
  } catch {
    // Calendar unavailable
  }

  // Reminders — pending
  try {
    const pendingReminders = await db
      .select({ title: reminders.title, dueAt: reminders.dueAt })
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "pending"),
          or(
            isNull(reminders.dueAt),
            lte(reminders.dueAt, new Date(now.getTime() + 24 * 60 * 60_000))
          )
        )
      )
      .limit(5);

    if (pendingReminders.length > 0) {
      const reminderList = pendingReminders.map((r) => r.title).join(", ");
      signals.push({
        check: "morning_briefing",
        priority: "medium",
        summary: `Pending reminders: ${reminderList}.`,
        detail: `Reminders to take care of: ${reminderList}.`,
      });
    }
  } catch {
    // Reminders unavailable
  }

  // Health — sleep and activity from last night
  try {
    const { getHealthForDate } = await import("@/lib/integrations/health");
    const today = now.toISOString().slice(0, 10);
    const healthData = await getHealthForDate(today);
    if (healthData) {
      const parts: string[] = [];
      if (healthData.sleepHours != null) {
        const sleepStr = healthData.sleepMinutes
          ? `${healthData.sleepHours}h ${healthData.sleepMinutes}m`
          : `${healthData.sleepHours}h`;
        parts.push(`${sleepStr} of sleep${healthData.sleepQuality ? ` (${healthData.sleepQuality})` : ""}`);
      }
      if (healthData.restingHeartRate != null) {
        parts.push(`resting HR ${healthData.restingHeartRate} bpm`);
      }
      if (parts.length > 0) {
        signals.push({
          check: "morning_briefing",
          priority: healthData.sleepHours != null && healthData.sleepHours < 6 ? "medium" : "low",
          summary: `Health: ${parts.join(", ")}.`,
          detail: `Last night: ${parts.join(", ")}.`,
        });
      }
    }
  } catch {
    // Health unavailable
  }

  // Wrap all signals with a greeting context
  if (signals.length > 0) {
    signals.unshift({
      check: "morning_briefing",
      priority: "medium",
      summary: `Good ${greeting}, Roy. Here's your daily briefing.`,
      detail: `Time to deliver the morning briefing.`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// LLM decision layer — should Nicole surface this?
// ---------------------------------------------------------------------------

const HEARTBEAT_DECISION_PROMPT = `You are Nicole's heartbeat system. You receive signals about Roy's current state — calendar, reminders, screen time, time of day, weather.

Your job: decide if any of these signals are worth interrupting Roy for RIGHT NOW.

Rules:
- Most of the time, the answer is NO. Silence is the default. Roy is busy.
- Only surface something if it's genuinely time-sensitive or important.
- If there's a meeting in 25+ minutes, it can probably wait for the next check.
- If there's a meeting in 10 minutes or less, that's worth saying.
- Overdue reminders are worth surfacing once, not repeatedly.
- Late night notices are worth one gentle nudge, not nagging.
- Screen time warnings are low priority — only mention if it's been 2+ hours.
- Weather alerts (extreme heat, storms, freezing) are worth one nudge.
- Never be preachy, nagging, or guilt-tripping. One clean sentence.

If you decide to nudge, respond with ONLY a JSON object:
{"nudge": true, "message": "Your meeting with Dr. Adewale is in 10 minutes.", "priority": "high", "speakable": true}

If no nudge is warranted, respond with:
{"nudge": false}

"speakable" means Nicole should say this out loud if voice mode is active. Set to false for low-priority items that should just be a notification.

Keep the message SHORT — one sentence, like a person would say it. Not a report.`;

const MORNING_BRIEFING_PROMPT = `You are Nicole. It's morning and Roy just started his day. You're delivering his daily briefing — proactively, without him asking.

You'll receive signals about today's weather, calendar, and reminders. Compose a natural, warm morning greeting that covers everything in 2-4 sentences. Sound like a real person, not a dashboard.

Examples of good briefings:
- "Good morning, Roy. It's 18°C and partly cloudy — should stay dry today. You've got a call with the team at 2 PM, and that reminder about the dentist is still pending."
- "Morning. Heads up — 70% chance of rain later, so grab an umbrella if you're heading out. Calendar's clear today, just that reminder to review the contract."
- "Good morning. It's a cold one — 3°C and foggy. No meetings today, so you've got a clear run."

Rules:
- Always lead with a greeting that matches the time.
- Mention weather naturally — temperature, conditions, and anything Roy should know (rain, extreme heat, etc.).
- Mention calendar events if any, with times.
- Mention pending reminders briefly if any.
- If calendar is clear, say so — that's useful info too.
- Keep it conversational. No bullet points, no headers.
- 2-4 sentences max. Don't ramble.
- This should feel like Nicole talking to Roy face to face.

Respond with ONLY a JSON object:
{"nudge": true, "message": "Good morning, Roy. ...", "priority": "medium", "speakable": true}`;

async function decideNudge(
  signals: HeartbeatSignal[],
  state: HeartbeatState,
  systemPromptOverride?: string
): Promise<HeartbeatNudge | null> {
  if (signals.length === 0) return null;

  const signalBlock = signals
    .map(
      (s) =>
        `[${s.check}] (${s.priority}) ${s.summary}`
    )
    .join("\n");

  // Include recently delivered nudges so the LLM avoids repeating
  const recentNudgeIds = state.deliveredNudgeIds.slice(-5);
  const recentBlock = recentNudgeIds.length > 0
    ? `\n\nRecently delivered nudges (don't repeat these):\n${recentNudgeIds.join("\n")}`
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPromptOverride || HEARTBEAT_DECISION_PROMPT },
    {
      role: "user",
      content: `Current signals:\n${signalBlock}${recentBlock}`,
    },
  ];

  try {
    const response = await chat(messages, { temperature: 0, maxTokens: 200 });
    const text = typeof response === "string" ? response : String(response);
    const cleaned = text
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.nudge) return null;

    const nudgeId = `${Date.now()}-${signals.map((s) => s.check).join("+")}`;

    return {
      id: nudgeId,
      message: parsed.message || signals[0].summary,
      priority: parsed.priority || "medium",
      speakable: parsed.speakable !== false,
      signals: signals.map((s) => s.check),
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Heartbeat LLM decision failed:", error);

    // Fallback: if there's a high/urgent signal, surface it without LLM
    const urgent = signals.find(
      (s) => s.priority === "urgent" || s.priority === "high"
    );
    if (urgent) {
      return {
        id: `${Date.now()}-fallback`,
        message: urgent.summary,
        priority: urgent.priority,
        speakable: true,
        signals: [urgent.check],
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Main heartbeat runner
// ---------------------------------------------------------------------------

export async function runHeartbeat(opts?: {
  activeApp?: string | null;
}): Promise<HeartbeatResult> {
  const config = await loadConfig();

  if (!config.enabled) {
    return { nudge: null, signals: [], skippedReason: "Heartbeat disabled" };
  }

  const state = await loadState();
  const now = nowMs();

  // Rate limiting — don't nudge too frequently
  if (
    state.lastNudgeTime > 0 &&
    minutesSince(state.lastNudgeTime) < config.cooldownMinutes
  ) {
    return {
      nudge: null,
      signals: [],
      skippedReason: `Cooldown active (${Math.round(config.cooldownMinutes - minutesSince(state.lastNudgeTime))}min remaining)`,
    };
  }

  // Quiet hours
  const quiet = isQuietHours(config.quietHoursStart, config.quietHoursEnd);

  // Morning briefing — proactive daily kickoff (runs once per day)
  if (!quiet && shouldDeliverMorningBriefing(state, config)) {
    const briefingSignals = await buildMorningBriefing(config);
    if (briefingSignals.length > 0) {
      const nudge = await decideNudge(briefingSignals, state, MORNING_BRIEFING_PROMPT);
      if (nudge) {
        state.lastMorningBriefingDate = new Date().toISOString().slice(0, 10);
        state.lastNudgeTime = now;
        state.deliveredNudgeIds.push(nudge.message);
        await saveState(state);
        return { nudge, signals: briefingSignals, skippedReason: null };
      }
    }
    // Mark as attempted even if LLM decided not to nudge, so we don't retry
    state.lastMorningBriefingDate = new Date().toISOString().slice(0, 10);
  }

  // Collect signals from all enabled checks
  const signals: HeartbeatSignal[] = [];

  if (
    config.checks.calendar.enabled &&
    shouldRunCheck("calendar", config.checks.calendar.intervalMinutes, state)
  ) {
    const calSignals = await checkCalendar(config.checks.calendar);
    signals.push(...calSignals);
    state.lastCheckTimes.calendar = now;
  }

  if (
    config.checks.reminders.enabled &&
    shouldRunCheck("reminders", config.checks.reminders.intervalMinutes, state)
  ) {
    const remSignals = await checkReminders();
    signals.push(...remSignals);
    state.lastCheckTimes.reminders = now;
  }

  if (
    config.checks.screenTime.enabled &&
    shouldRunCheck("screen_time", config.checks.screenTime.intervalMinutes, state)
  ) {
    const stSignals = checkScreenTime(state, config.checks.screenTime, opts?.activeApp);
    signals.push(...stSignals);
    state.lastCheckTimes.screen_time = now;
  }

  if (
    config.checks.timeAwareness.enabled &&
    shouldRunCheck("time_awareness", config.checks.timeAwareness.intervalMinutes, state)
  ) {
    const taSignals = checkTimeAwareness(config.checks.timeAwareness);
    signals.push(...taSignals);
    state.lastCheckTimes.time_awareness = now;
  }

  if (
    config.checks.weather.enabled &&
    shouldRunCheck("weather", config.checks.weather.intervalMinutes, state)
  ) {
    const weatherSignals = await checkWeather(config.checks.weather.location);
    signals.push(...weatherSignals);
    state.lastCheckTimes.weather = now;
  }

  if (
    config.checks.health.enabled &&
    shouldRunCheck("health", config.checks.health.intervalMinutes, state)
  ) {
    const healthSignals = await checkHealth();
    signals.push(...healthSignals);
    state.lastCheckTimes.health = now;
  }

  // During quiet hours, only surface urgent signals
  if (quiet) {
    const urgentOnly = signals.filter((s) => s.priority === "urgent");
    if (urgentOnly.length === 0 || !config.overrideForUrgent) {
      await saveState(state);
      return {
        nudge: null,
        signals,
        skippedReason: "Quiet hours",
      };
    }
    signals.length = 0;
    signals.push(...urgentOnly);
  }

  if (signals.length === 0) {
    await saveState(state);
    return { nudge: null, signals: [], skippedReason: null };
  }

  // Ask the LLM whether to surface any of these
  const nudge = await decideNudge(signals, state);

  if (nudge) {
    state.lastNudgeTime = now;
    state.deliveredNudgeIds.push(nudge.message);
  }

  await saveState(state);

  return { nudge, signals, skippedReason: null };
}

// ---------------------------------------------------------------------------
// Workspace context for screen time tracking
// ---------------------------------------------------------------------------

export async function updateScreenTimeContext(
  activeApp: string | null
): Promise<void> {
  const state = await loadState();
  const now = nowMs();
  const tracker = state.screenTimeTracker;

  if (!activeApp || activeApp === "Nicole") {
    // Not tracking Nicole's own app
    tracker.currentApp = null;
    tracker.appStartTime = null;
  } else if (tracker.currentApp !== activeApp) {
    tracker.currentApp = activeApp;
    tracker.appStartTime = now;
  }

  await saveState(state);
}

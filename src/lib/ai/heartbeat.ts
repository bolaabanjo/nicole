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
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = join(homedir(), ".nicole");
const STATE_PATH = join(WORKSPACE_DIR, "heartbeat_state.json");

// ---------------------------------------------------------------------------
// Config (parsed from heartbeat.md structure, with defaults)
// ---------------------------------------------------------------------------

function getConfig(): HeartbeatConfig {
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
    },
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function defaultState(): HeartbeatState {
  return {
    lastCheckTimes: {},
    lastNudgeTime: 0,
    deliveredNudgeIds: [],
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

// ---------------------------------------------------------------------------
// LLM decision layer — should Nicole surface this?
// ---------------------------------------------------------------------------

const HEARTBEAT_DECISION_PROMPT = `You are Nicole's heartbeat system. You receive signals about Roy's current state — calendar, reminders, screen time, time of day.

Your job: decide if any of these signals are worth interrupting Roy for RIGHT NOW.

Rules:
- Most of the time, the answer is NO. Silence is the default. Roy is busy.
- Only surface something if it's genuinely time-sensitive or important.
- If there's a meeting in 25+ minutes, it can probably wait for the next check.
- If there's a meeting in 10 minutes or less, that's worth saying.
- Overdue reminders are worth surfacing once, not repeatedly.
- Late night notices are worth one gentle nudge, not nagging.
- Screen time warnings are low priority — only mention if it's been 2+ hours.
- Never be preachy, nagging, or guilt-tripping. One clean sentence.

If you decide to nudge, respond with ONLY a JSON object:
{"nudge": true, "message": "Your meeting with Dr. Adewale is in 10 minutes.", "priority": "high", "speakable": true}

If no nudge is warranted, respond with:
{"nudge": false}

"speakable" means Nicole should say this out loud if voice mode is active. Set to false for low-priority items that should just be a notification.

Keep the message SHORT — one sentence, like a person would say it. Not a report.`;

async function decideNudge(
  signals: HeartbeatSignal[],
  state: HeartbeatState
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
    { role: "system", content: HEARTBEAT_DECISION_PROMPT },
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
  const config = getConfig();

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

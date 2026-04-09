/**
 * Health tracking integration.
 *
 * Receives daily health snapshots pushed from iPhone (via Shortcuts or iOS app),
 * stores them in PostgreSQL, and provides query functions for the heartbeat
 * system and health_metric_read tool.
 */

import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { healthMetrics } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthSnapshot {
  date: string; // YYYY-MM-DD
  sleepHours?: number;
  sleepMinutes?: number;
  sleepQuality?: string;
  steps?: number;
  activeMinutes?: number;
  restingHeartRate?: number;
  heartRateAvg?: number;
  heartRateMax?: number;
  caloriesBurned?: number;
  waterMl?: number;
  weight?: number; // grams
  mood?: string;
  notes?: string;
  rawData?: Record<string, unknown>;
}

export interface HealthSummary {
  today: HealthSnapshot | null;
  weekAvg: {
    sleepHours: number | null;
    steps: number | null;
    restingHeartRate: number | null;
    activeMinutes: number | null;
  };
  trend: string | null;
}

// ---------------------------------------------------------------------------
// Store health data
// ---------------------------------------------------------------------------

export async function storeHealthSnapshot(
  snapshot: HealthSnapshot
): Promise<{ ok: boolean; date: string }> {
  // Upsert — update if same date exists
  const existing = await db
    .select({ id: healthMetrics.id })
    .from(healthMetrics)
    .where(eq(healthMetrics.date, snapshot.date))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(healthMetrics)
      .set({
        sleepHours: snapshot.sleepHours ?? null,
        sleepMinutes: snapshot.sleepMinutes ?? null,
        sleepQuality: snapshot.sleepQuality ?? null,
        steps: snapshot.steps ?? null,
        activeMinutes: snapshot.activeMinutes ?? null,
        restingHeartRate: snapshot.restingHeartRate ?? null,
        heartRateAvg: snapshot.heartRateAvg ?? null,
        heartRateMax: snapshot.heartRateMax ?? null,
        caloriesBurned: snapshot.caloriesBurned ?? null,
        waterMl: snapshot.waterMl ?? null,
        weight: snapshot.weight ?? null,
        mood: snapshot.mood ?? null,
        notes: snapshot.notes ?? null,
        rawData: snapshot.rawData ?? null,
        pushedAt: new Date(),
      })
      .where(eq(healthMetrics.date, snapshot.date));
  } else {
    await db.insert(healthMetrics).values({
      date: snapshot.date,
      sleepHours: snapshot.sleepHours ?? null,
      sleepMinutes: snapshot.sleepMinutes ?? null,
      sleepQuality: snapshot.sleepQuality ?? null,
      steps: snapshot.steps ?? null,
      activeMinutes: snapshot.activeMinutes ?? null,
      restingHeartRate: snapshot.restingHeartRate ?? null,
      heartRateAvg: snapshot.heartRateAvg ?? null,
      heartRateMax: snapshot.heartRateMax ?? null,
      caloriesBurned: snapshot.caloriesBurned ?? null,
      waterMl: snapshot.waterMl ?? null,
      weight: snapshot.weight ?? null,
      mood: snapshot.mood ?? null,
      notes: snapshot.notes ?? null,
      rawData: snapshot.rawData ?? null,
    });
  }

  return { ok: true, date: snapshot.date };
}

// ---------------------------------------------------------------------------
// Query health data
// ---------------------------------------------------------------------------

export async function getHealthForDate(
  date: string
): Promise<HealthSnapshot | null> {
  const rows = await db
    .select()
    .from(healthMetrics)
    .where(eq(healthMetrics.date, date))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToSnapshot(rows[0]);
}

export async function getRecentHealth(
  days: number = 7
): Promise<HealthSnapshot[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const rows = await db
    .select()
    .from(healthMetrics)
    .where(gte(healthMetrics.date, cutoffDate))
    .orderBy(desc(healthMetrics.date))
    .limit(days);

  return rows.map(rowToSnapshot);
}

export async function getHealthSummary(): Promise<HealthSummary> {
  const today = new Date().toISOString().slice(0, 10);
  const todayData = await getHealthForDate(today);
  const recent = await getRecentHealth(7);

  // Calculate weekly averages
  const withSleep = recent.filter((r) => r.sleepHours != null);
  const withSteps = recent.filter((r) => r.steps != null);
  const withHR = recent.filter((r) => r.restingHeartRate != null);
  const withActive = recent.filter((r) => r.activeMinutes != null);

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const weekAvg = {
    sleepHours: avg(withSleep.map((r) => r.sleepHours! + (r.sleepMinutes || 0) / 60)),
    steps: avg(withSteps.map((r) => r.steps!)),
    restingHeartRate: avg(withHR.map((r) => r.restingHeartRate!)),
    activeMinutes: avg(withActive.map((r) => r.activeMinutes!)),
  };

  // Simple trend detection
  let trend: string | null = null;
  if (withSleep.length >= 3) {
    const recentSleep = withSleep.slice(0, 3).map((r) => r.sleepHours!);
    const avgRecent = recentSleep.reduce((a, b) => a + b, 0) / recentSleep.length;
    if (avgRecent < 6) trend = "Sleep has been low recently.";
    else if (avgRecent >= 8) trend = "Sleep has been solid this week.";
  }
  if (withSteps.length >= 3) {
    const recentSteps = withSteps.slice(0, 3).map((r) => r.steps!);
    const avgSteps = recentSteps.reduce((a, b) => a + b, 0) / recentSteps.length;
    if (avgSteps < 3000) {
      trend = (trend ? trend + " " : "") + "Activity has been low — not many steps.";
    }
  }

  return { today: todayData, weekAvg, trend };
}

// ---------------------------------------------------------------------------
// Format for prompt / heartbeat
// ---------------------------------------------------------------------------

export function formatHealthForPrompt(summary: HealthSummary): string {
  const lines: string[] = [];

  if (summary.today) {
    const t = summary.today;
    lines.push("**Today's health:**");
    if (t.sleepHours != null) {
      const sleepStr = t.sleepMinutes
        ? `${t.sleepHours}h ${t.sleepMinutes}m`
        : `${t.sleepHours}h`;
      lines.push(`- Sleep: ${sleepStr}${t.sleepQuality ? ` (${t.sleepQuality})` : ""}`);
    }
    if (t.steps != null) lines.push(`- Steps: ${t.steps.toLocaleString()}`);
    if (t.activeMinutes != null) lines.push(`- Active: ${t.activeMinutes} min`);
    if (t.restingHeartRate != null) lines.push(`- Resting HR: ${t.restingHeartRate} bpm`);
    if (t.caloriesBurned != null) lines.push(`- Calories: ${t.caloriesBurned}`);
    if (t.mood) lines.push(`- Mood: ${t.mood}`);
  } else {
    lines.push("No health data for today yet.");
  }

  const w = summary.weekAvg;
  if (w.sleepHours || w.steps || w.restingHeartRate) {
    lines.push("\n**7-day averages:**");
    if (w.sleepHours) lines.push(`- Sleep: ${w.sleepHours}h`);
    if (w.steps) lines.push(`- Steps: ${w.steps.toLocaleString()}`);
    if (w.restingHeartRate) lines.push(`- Resting HR: ${w.restingHeartRate} bpm`);
    if (w.activeMinutes) lines.push(`- Active: ${w.activeMinutes} min`);
  }

  if (summary.trend) lines.push(`\n${summary.trend}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Heartbeat check
// ---------------------------------------------------------------------------

export async function checkHealthForHeartbeat(): Promise<{
  shouldAlert: boolean;
  summary: string;
} | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const data = await getHealthForDate(today);
    if (!data) return null;

    const alerts: string[] = [];

    // Low sleep alert
    if (data.sleepHours != null && data.sleepHours < 5) {
      alerts.push(`only ${data.sleepHours}h of sleep last night`);
    }

    // High resting heart rate
    if (data.restingHeartRate != null && data.restingHeartRate > 100) {
      alerts.push(`resting heart rate is elevated at ${data.restingHeartRate} bpm`);
    }

    // Mood check
    if (data.mood === "bad" || data.mood === "low") {
      alerts.push(`mood logged as ${data.mood}`);
    }

    if (alerts.length === 0) return null;

    return {
      shouldAlert: true,
      summary: `Health: ${alerts.join(", ")}.`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSnapshot(row: typeof healthMetrics.$inferSelect): HealthSnapshot {
  return {
    date: row.date,
    sleepHours: row.sleepHours ?? undefined,
    sleepMinutes: row.sleepMinutes ?? undefined,
    sleepQuality: row.sleepQuality ?? undefined,
    steps: row.steps ?? undefined,
    activeMinutes: row.activeMinutes ?? undefined,
    restingHeartRate: row.restingHeartRate ?? undefined,
    heartRateAvg: row.heartRateAvg ?? undefined,
    heartRateMax: row.heartRateMax ?? undefined,
    caloriesBurned: row.caloriesBurned ?? undefined,
    waterMl: row.waterMl ?? undefined,
    weight: row.weight ?? undefined,
    mood: row.mood ?? undefined,
    notes: row.notes ?? undefined,
    rawData: (row.rawData as Record<string, unknown>) ?? undefined,
  };
}

import { NextRequest, NextResponse } from "next/server";
import {
  storeHealthSnapshot,
  getHealthSummary,
  formatHealthForPrompt,
  type HealthSnapshot,
} from "@/lib/integrations/health";

/**
 * POST /api/nicole/health — push a health snapshot (from iPhone Shortcut or iOS app)
 * GET  /api/nicole/health — get current health summary
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Validate date
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return NextResponse.json(
        { error: "date is required in YYYY-MM-DD format" },
        { status: 400 }
      );
    }

    const int = (v: unknown) => typeof v === "number" ? Math.round(v) : undefined;

    const snapshot: HealthSnapshot = {
      date: body.date,
      sleepHours: int(body.sleepHours),
      sleepMinutes: int(body.sleepMinutes),
      sleepQuality: typeof body.sleepQuality === "string" ? body.sleepQuality : undefined,
      steps: int(body.steps),
      activeMinutes: int(body.activeMinutes),
      restingHeartRate: int(body.restingHeartRate),
      heartRateAvg: int(body.heartRateAvg),
      heartRateMax: int(body.heartRateMax),
      caloriesBurned: int(body.caloriesBurned),
      waterMl: int(body.waterMl),
      weight: int(body.weight),
      mood: typeof body.mood === "string" ? body.mood : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      rawData: typeof body.rawData === "object" ? body.rawData : undefined,
    };

    const result = await storeHealthSnapshot(snapshot);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Health push error:", error);
    return NextResponse.json(
      { error: "Failed to store health data" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const summary = await getHealthSummary();
    return NextResponse.json({
      ...summary,
      formatted: formatHealthForPrompt(summary),
    });
  } catch (error) {
    console.error("Health read error:", error);
    return NextResponse.json(
      { error: "Failed to read health data" },
      { status: 500 }
    );
  }
}

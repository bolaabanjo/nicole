import { NextRequest, NextResponse } from "next/server";
import { runHeartbeat, updateScreenTimeContext } from "@/lib/ai/heartbeat";

/**
 * Nicole's heartbeat endpoint.
 * Called by the Mac app every 5 minutes to check for proactive nudges.
 *
 * GET /api/nicole/heartbeat
 * Optional query params:
 *   - activeApp: the currently focused app name (for screen time tracking)
 *
 * Returns:
 *   { nudge: { id, message, priority, speakable, timestamp } | null, signalCount: number }
 */
export async function GET(req: NextRequest) {
  try {
    const activeApp = req.nextUrl.searchParams.get("activeApp");

    // Update screen time tracking with the current app
    if (activeApp) {
      await updateScreenTimeContext(activeApp);
    }

    const result = await runHeartbeat({ activeApp });

    return NextResponse.json({
      nudge: result.nudge,
      signalCount: result.signals.length,
      skippedReason: result.skippedReason,
    });
  } catch (error) {
    console.error("Heartbeat endpoint error:", error);
    return NextResponse.json(
      { nudge: null, signalCount: 0, error: "Heartbeat check failed" },
      { status: 500 }
    );
  }
}

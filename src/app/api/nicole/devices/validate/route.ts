import { NextRequest, NextResponse } from "next/server";
import { validateTrustedDevice } from "@/lib/auth/trusted-devices";

export async function GET(req: NextRequest) {
  try {
    const device = await validateTrustedDevice(req);

    if (!device) {
      return NextResponse.json(
        { valid: false, error: "Trusted device token is invalid or missing." },
        { status: 401 }
      );
    }

    return NextResponse.json({
      valid: true,
      device,
    });
  } catch (error) {
    console.error("Device validation error:", error);
    return NextResponse.json(
      { valid: false, error: "Failed to validate trusted device." },
      { status: 500 }
    );
  }
}

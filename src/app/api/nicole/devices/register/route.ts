import { NextRequest, NextResponse } from "next/server";
import {
  assertTrustedDevicePairingCode,
  registerTrustedDevice,
  TrustedDeviceAuthError,
} from "@/lib/auth/trusted-devices";

interface RegisterDeviceRequest {
  pairingCode?: string;
  deviceName?: string;
  platform?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RegisterDeviceRequest;
    const pairingCode = body.pairingCode?.trim();
    const deviceName = body.deviceName?.trim();

    if (!pairingCode || !deviceName) {
      return NextResponse.json(
        { error: "Pairing code and device name are required." },
        { status: 400 }
      );
    }

    assertTrustedDevicePairingCode(pairingCode);

    const device = await registerTrustedDevice({
      deviceName,
      platform: body.platform || "ios",
      metadata: {
        userAgent: req.headers.get("user-agent"),
      },
    });

    return NextResponse.json(device);
  } catch (error) {
    if (error instanceof TrustedDeviceAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("Device registration error:", error);
    return NextResponse.json(
      { error: "Failed to register trusted device." },
      { status: 500 }
    );
  }
}

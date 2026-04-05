import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { trustedDevices } from "@/lib/db/schema";

export const NICOLE_DEVICE_ID_HEADER = "x-nicole-device-id";
export const NICOLE_DEVICE_TOKEN_HEADER = "x-nicole-device-token";
export const NICOLE_CLIENT_SURFACE_HEADER = "x-nicole-client-surface";
const DEFAULT_PLATFORM = "ios";

export class TrustedDeviceAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "TrustedDeviceAuthError";
    this.status = status;
  }
}

export interface TrustedDeviceRegistration {
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  platform: string;
}

export interface TrustedDeviceRecord {
  id: string;
  name: string;
  platform: string;
}

export function getDeclaredClientSurface(req: NextRequest): string | undefined {
  const surface = req.headers.get(NICOLE_CLIENT_SURFACE_HEADER)?.trim().toLowerCase();
  return surface || undefined;
}

export function isIOSClientRequest(req: NextRequest, fallbackSurface?: string) {
  return (fallbackSurface || getDeclaredClientSurface(req)) === "ios";
}

export function isTrustedDevicePairingConfigured() {
  return Boolean(getTrustedDevicePairingCode());
}

export async function registerTrustedDevice(input: {
  deviceName: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}) {
  const platform = normalizePlatform(input.platform);
  const deviceName = input.deviceName.trim();

  if (!deviceName) {
    throw new TrustedDeviceAuthError("Device name is required.", 400);
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const [device] = await db
    .insert(trustedDevices)
    .values({
      platform,
      name: deviceName,
      tokenHash,
      metadata: input.metadata ?? null,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({
      id: trustedDevices.id,
      name: trustedDevices.name,
      platform: trustedDevices.platform,
    });

  if (!device) {
    throw new TrustedDeviceAuthError("Failed to register trusted device.", 500);
  }

  return {
    deviceId: device.id,
    deviceToken: token,
    deviceName: device.name,
    platform: device.platform,
  } satisfies TrustedDeviceRegistration;
}

export async function validateTrustedDevice(req: NextRequest): Promise<TrustedDeviceRecord | null> {
  const deviceId = req.headers.get(NICOLE_DEVICE_ID_HEADER)?.trim();
  const deviceToken = req.headers.get(NICOLE_DEVICE_TOKEN_HEADER)?.trim();

  if (!deviceId || !deviceToken) {
    return null;
  }

  const device = await getTrustedDeviceById(deviceId);
  if (!device || !safeEqualHash(device.tokenHash, hashToken(deviceToken))) {
    return null;
  }

  await db
    .update(trustedDevices)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(trustedDevices.id, deviceId));

  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
  };
}

export async function requireTrustedDeviceForIOS(
  req: NextRequest,
  fallbackSurface?: string
): Promise<TrustedDeviceRecord | null> {
  if (!isIOSClientRequest(req, fallbackSurface)) {
    return null;
  }

  const device = await validateTrustedDevice(req);
  if (!device) {
    throw new TrustedDeviceAuthError(
      "This iPhone is not paired with Nicole yet. Re-open the app settings and connect it to Banjo.",
      401
    );
  }

  return device;
}

export function assertTrustedDevicePairingCode(pairingCode: string) {
  const configured = getTrustedDevicePairingCode();

  if (!configured) {
    throw new TrustedDeviceAuthError(
      "Trusted-device pairing is not configured on Banjo. Set NICOLE_DEVICE_PAIRING_CODE in .env.local.",
      503
    );
  }

  if (!safeEqualHash(hashToken(configured), hashToken(pairingCode.trim()))) {
    throw new TrustedDeviceAuthError("Pairing code is invalid.", 401);
  }
}

async function getTrustedDeviceById(deviceId: string) {
  const rows = await db
    .select({
      id: trustedDevices.id,
      name: trustedDevices.name,
      platform: trustedDevices.platform,
      tokenHash: trustedDevices.tokenHash,
    })
    .from(trustedDevices)
    .where(and(eq(trustedDevices.id, deviceId), isNull(trustedDevices.revokedAt)))
    .limit(1);

  return rows[0] || null;
}

function getTrustedDevicePairingCode() {
  return (
    process.env.NICOLE_DEVICE_PAIRING_CODE?.trim() ||
    process.env.NICOLE_DEVICE_REGISTRATION_SECRET?.trim() ||
    ""
  );
}

function normalizePlatform(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return normalized || DEFAULT_PLATFORM;
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHash(lhs: string, rhs: string) {
  const left = Buffer.from(lhs);
  const right = Buffer.from(rhs);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

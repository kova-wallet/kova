import { NextRequest, NextResponse } from "next/server";
import { getRecentAlerts, clearAlerts, fireAlert } from "@/lib/alerts";
import type { AlertLevel } from "@/lib/alerts";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
  return NextResponse.json({ alerts: getRecentAlerts(limit) });
}

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { action } = body as { action: string };

    if (action === "clear") {
      clearAlerts();
      return NextResponse.json({ cleared: true });
    }

    if (action === "test") {
      await fireAlert({
        type: "test_alert",
        level: (body.level as AlertLevel) || "info",
        message: body.message || "Test alert from dashboard",
        walletAddress: body.walletAddress || "test",
        timestamp: Date.now(),
      });
      return NextResponse.json({ sent: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Alert operation failed" },
      { status: 500 }
    );
  }
}

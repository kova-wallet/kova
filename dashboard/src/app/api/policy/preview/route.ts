import { NextRequest, NextResponse } from "next/server";
import { Policy } from "@kova/policy/builder.js";
import { requireDashboardAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const config = await req.json();
    Policy.fromJSON(config);
    return NextResponse.json({ valid: true, config });
  } catch (e) {
    return NextResponse.json({
      valid: false,
      error: e instanceof Error ? e.message : "Invalid policy config",
    });
  }
}

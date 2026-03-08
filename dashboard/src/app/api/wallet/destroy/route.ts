import { NextRequest, NextResponse } from "next/server";
import { destroyWallet } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    await destroyWallet();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to destroy wallet" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getWallet, isInitialized } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  const token = req.nextUrl.searchParams.get("token") ?? "SOL";
  try {
    const balance = await getWallet()!.getBalance(token);
    return NextResponse.json(balance);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to get balance" },
      { status: 500 }
    );
  }
}

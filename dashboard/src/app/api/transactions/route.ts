import { NextRequest, NextResponse } from "next/server";
import { getWallet, isInitialized } from "@/lib/wallet-manager";

export async function GET(req: NextRequest) {
  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  const limit = Math.max(1, Math.min(parseInt(
    req.nextUrl.searchParams.get("limit") ?? "20",
    10
  ) || 20, 100));

  try {
    const history = await getWallet()!.getTransactionHistory(limit);
    return NextResponse.json(history);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to get history" },
      { status: 500 }
    );
  }
}

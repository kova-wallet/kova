import { NextRequest, NextResponse } from "next/server";
import { listLoadedWallets } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  return NextResponse.json({ wallets: listLoadedWallets() });
}

import { NextRequest, NextResponse } from "next/server";
import { switchWallet } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const { address } = (await req.json()) as { address: string };
    if (!address) {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }
    switchWallet(address);
    return NextResponse.json({ active: address });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to switch wallet" },
      { status: 400 }
    );
  }
}

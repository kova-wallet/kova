import { NextRequest, NextResponse } from "next/server";
import { switchWallet } from "@/lib/wallet-manager";

export async function POST(req: NextRequest) {
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

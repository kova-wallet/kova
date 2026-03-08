import { NextResponse } from "next/server";
import { listLoadedWallets } from "@/lib/wallet-manager";

export async function GET() {
  return NextResponse.json({ wallets: listLoadedWallets() });
}

import { NextResponse } from "next/server";
import { requestAirdrop, isInitialized } from "@/lib/wallet-manager";

export async function POST() {
  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  try {
    const signature = await requestAirdrop();
    const { getConfig } = await import("@/lib/config");
    return NextResponse.json({ signature, amount: String(getConfig().airdropAmountSol) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Airdrop failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

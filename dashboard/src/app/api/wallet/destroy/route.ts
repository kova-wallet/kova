import { NextResponse } from "next/server";
import { destroyWallet } from "@/lib/wallet-manager";

export async function POST() {
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

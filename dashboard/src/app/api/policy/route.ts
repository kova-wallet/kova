import { NextRequest, NextResponse } from "next/server";
import {
  getWallet,
  getPolicyConfig,
  isInitialized,
  applyPolicy,
} from "@/lib/wallet-manager";

export async function GET() {
  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  try {
    const summary = await getWallet()!.getPolicy();
    const config = getPolicyConfig();
    return NextResponse.json({ summary, config });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to get policy" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  try {
    const config = await req.json();
    await applyPolicy(config);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to apply policy" },
      { status: 400 }
    );
  }
}

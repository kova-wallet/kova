import { NextRequest, NextResponse } from "next/server";
import { Policy } from "@kova/policy/builder.js";

export async function POST(req: NextRequest) {
  try {
    const config = await req.json();
    Policy.fromJSON(config);
    return NextResponse.json({ valid: true, config });
  } catch (e) {
    return NextResponse.json({
      valid: false,
      error: e instanceof Error ? e.message : "Invalid policy config",
    });
  }
}

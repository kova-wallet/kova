import { NextResponse } from "next/server";
import { getApprovalChannel } from "@/lib/wallet-manager";

export async function GET() {
  const channel = getApprovalChannel();
  if (!channel) {
    return NextResponse.json([]);
  }

  return NextResponse.json(channel.getPendingApprovals());
}

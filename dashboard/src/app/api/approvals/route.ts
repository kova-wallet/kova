import { NextRequest, NextResponse } from "next/server";
import { getApprovalChannel } from "@/lib/wallet-manager";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  const channel = getApprovalChannel();
  if (!channel) {
    return NextResponse.json([]);
  }

  return NextResponse.json(channel.getPendingApprovals());
}

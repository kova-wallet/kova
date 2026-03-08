import { NextRequest, NextResponse } from "next/server";
import { getApprovalChannel } from "@/lib/wallet-manager";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getApprovalChannel();

  if (!channel) {
    return NextResponse.json(
      { error: "No approval channel active" },
      { status: 400 }
    );
  }

  try {
    const body = await req.json();
    const { decision } = body as { decision: "approved" | "rejected" };

    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        { error: "Decision must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }

    const success = channel.respondToApproval(id, decision);

    if (!success) {
      return NextResponse.json(
        { error: "Request not found or already resolved" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to process" },
      { status: 500 }
    );
  }
}

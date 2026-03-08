import { NextRequest, NextResponse } from "next/server";
import { queryAuditLog } from "@/lib/audit-log";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const params = req.nextUrl.searchParams;
    const entries = await queryAuditLog({
      limit: Number(params.get("limit")) || 100,
      status: params.get("status") || undefined,
      search: params.get("search") || undefined,
      after: params.get("after") ? Number(params.get("after")) : undefined,
      before: params.get("before") ? Number(params.get("before")) : undefined,
    });
    return NextResponse.json({ entries, count: entries.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to query audit log" },
      { status: 500 }
    );
  }
}

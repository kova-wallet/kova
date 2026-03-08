import { NextRequest, NextResponse } from "next/server";
import { createApiKey, listApiKeys, revokeApiKey, deleteApiKey } from "@/lib/api-keys";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  return NextResponse.json({ keys: listApiKeys() });
}

export async function POST(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  try {
    const body = await req.json();
    const { action } = body as { action: string };

    if (action === "create") {
      const { label, walletAddress } = body as { label: string; walletAddress: string };
      if (!label) {
        return NextResponse.json({ error: "label is required" }, { status: 400 });
      }
      const result = createApiKey(label, walletAddress || "*");
      return NextResponse.json(result);
    }

    if (action === "revoke") {
      const { id } = body as { id: string };
      const ok = revokeApiKey(id);
      return ok
        ? NextResponse.json({ revoked: true })
        : NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    if (action === "delete") {
      const { id } = body as { id: string };
      const ok = deleteApiKey(id);
      return ok
        ? NextResponse.json({ deleted: true })
        : NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "API key operation failed" },
      { status: 500 }
    );
  }
}

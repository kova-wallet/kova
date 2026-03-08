import { NextRequest, NextResponse } from "next/server";
import { getWallet, getAddress, isInitialized } from "@/lib/wallet-manager";
import { validateApiKey, isKeyAuthorizedForWallet } from "@/lib/api-keys";
import { alertTransactionDenied } from "@/lib/alerts";

export const maxDuration = 180; // Allow long-running approval waits

/**
 * Authenticate request — accepts either:
 * - Dashboard session cookie (handled by middleware)
 * - API key via Authorization: Bearer kova_... header
 */
function authenticateAgent(req: NextRequest): { authorized: boolean; agentLabel?: string } {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer kova_")) {
    // No API key — rely on session auth from middleware
    return { authorized: true, agentLabel: "dashboard-user" };
  }

  const rawKey = authHeader.slice(7); // "Bearer " = 7 chars
  const key = validateApiKey(rawKey);
  if (!key) {
    return { authorized: false };
  }

  const walletAddress = getAddress();
  if (walletAddress && !isKeyAuthorizedForWallet(key, walletAddress)) {
    return { authorized: false };
  }

  return { authorized: true, agentLabel: key.label };
}

export async function POST(req: NextRequest) {
  if (!isInitialized()) {
    return NextResponse.json(
      { error: "No wallet created yet" },
      { status: 400 }
    );
  }

  const auth = authenticateAgent(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: "Invalid or unauthorized API key" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { type, params, metadata } = body;

    if (!type || !params) {
      return NextResponse.json(
        { error: "type and params are required" },
        { status: 400 }
      );
    }

    const intent = {
      type,
      chain: "solana" as const,
      params,
      metadata: metadata ?? { reason: `Transaction via ${auth.agentLabel ?? "dashboard"}` },
    };

    const result = await getWallet()!.execute(intent);

    // Fire alert for denied transactions
    if (result.status === "denied") {
      const address = getAddress();
      if (address) {
        alertTransactionDenied(
          address,
          result.error?.message ?? result.summary,
          result.intentId
        ).catch(() => {});
      }
    }

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Execution failed" },
      { status: 500 }
    );
  }
}

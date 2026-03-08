import { NextRequest, NextResponse } from "next/server";
import {
  listLoadedWallets,
  getActiveWalletName,
  switchWallet,
  isInitialized,
  getAddress,
  getSignerType,
} from "@/lib/wallet-manager";
import { getConfig } from "@/lib/config";

export async function GET() {
  const config = getConfig();
  return NextResponse.json({
    network: config.network,
    label: config.networkLabel,
    airdropEnabled: config.airdropEnabled,
    wallets: listLoadedWallets().map((w) => w.address),
    activeWallet: getActiveWalletName(),
    initialized: isInitialized(),
    address: getAddress(),
    signerType: getSignerType(),
    storeType: config.storeType,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body as { action: string };

    if (action === "switch-wallet") {
      const { address } = body as { address: string };
      if (!address || typeof address !== "string") {
        return NextResponse.json({ error: "Wallet address is required" }, { status: 400 });
      }
      switchWallet(address);
      return NextResponse.json({ active: address });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Operation failed" },
      { status: 500 },
    );
  }
}

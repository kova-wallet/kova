import { NextRequest, NextResponse } from "next/server";
import { isInitialized, getAddress, getActiveWalletName, getSignerType, listLoadedWallets } from "@/lib/wallet-manager";
import { getConfig } from "@/lib/config";
import { requireDashboardAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = requireDashboardAuth(req);
  if (!auth.authenticated) return auth.response;

  const config = getConfig();
  return NextResponse.json({
    initialized: isInitialized(),
    address: getAddress(),
    network: config.network,
    networkLabel: config.networkLabel,
    airdropEnabled: config.airdropEnabled,
    activeWallet: getActiveWalletName(),
    signerType: getSignerType(),
    storeType: config.storeType,
    loadedWallets: listLoadedWallets(),
  });
}

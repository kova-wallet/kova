import { NextRequest, NextResponse } from "next/server";
import { createWalletFromSource } from "@/lib/wallet-manager";
import type { WalletSourceConfig } from "@/lib/wallet-sources";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mode, secretKey, keyfileBytes, keyfilePath, turnkeyConfig } = body as {
      mode: "generate" | "import" | "keyfile" | "turnkey";
      secretKey?: number[];
      keyfileBytes?: number[];
      keyfilePath?: string;
      turnkeyConfig?: {
        apiBaseUrl: string;
        apiPublicKey: string;
        apiPrivateKey: string;
        organizationId: string;
        walletAddress: string;
      };
    };

    let sourceConfig: WalletSourceConfig;

    switch (mode) {
      case "generate":
        sourceConfig = { type: "generate" };
        break;

      case "import":
        if (!secretKey) {
          return NextResponse.json(
            { error: "secretKey is required when mode is 'import'" },
            { status: 400 }
          );
        }
        sourceConfig = { type: "secret-key", secretKey: JSON.stringify(secretKey) };
        break;

      case "keyfile":
        if (keyfileBytes) {
          sourceConfig = { type: "keyfile", keyfileBytes };
        } else if (keyfilePath) {
          sourceConfig = { type: "keyfile", keyfilePath };
        } else {
          return NextResponse.json(
            { error: "keyfileBytes or keyfilePath is required when mode is 'keyfile'" },
            { status: 400 }
          );
        }
        break;

      case "turnkey":
        if (!turnkeyConfig) {
          return NextResponse.json(
            { error: "turnkeyConfig is required when mode is 'turnkey'" },
            { status: 400 }
          );
        }
        sourceConfig = { type: "turnkey", turnkey: turnkeyConfig };
        break;

      default:
        return NextResponse.json({ error: `Unknown mode: ${mode}` }, { status: 400 });
    }

    const address = await createWalletFromSource(sourceConfig);

    return NextResponse.json({ address, sourceType: mode });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create wallet" },
      { status: 400 }
    );
  }
}

export const NETWORK_CONFIG = {
  label: "Localnet",
  rpcUrl: "http://localhost:8899",
  solanaNetwork: "devnet" as const, // solana-test-validator emulates devnet
  walletsDir: "../dashboard-demo-helpers/local/wallets",
  airdropEnabled: true,
};

export const AIRDROP_AMOUNT_SOL = 1;
export const AIRDROP_AMOUNT_LAMPORTS = AIRDROP_AMOUNT_SOL * 1_000_000_000;

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const APPROVAL_TIMEOUT_MS = 120_000; // 2 min for demo

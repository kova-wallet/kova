#!/usr/bin/env bash
# Start local Solana validator, generate a wallet if needed, then launch the dashboard.
#
# Usage:
#   ./start-local.sh          # normal start
#   ./start-local.sh --reset  # wipe ledger + wallets and start fresh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
HELPERS_DIR="$ROOT_DIR/dashboard-demo-helpers/local"
WALLETS_DIR="$HELPERS_DIR/wallets"
LEDGER_DIR="$HELPERS_DIR/test-ledger"

# ---- Prerequisites ----
if ! command -v solana-test-validator &> /dev/null; then
  echo "Error: solana-test-validator not found."
  echo "Install it with: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
  exit 1
fi

if ! command -v npx &> /dev/null; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

# ---- Reset flag ----
if [[ "${1:-}" == "--reset" ]]; then
  echo "Resetting ledger and wallets..."
  rm -rf "$LEDGER_DIR"
  rm -f "$WALLETS_DIR"/*.json
fi

# ---- Ensure wallets directory exists ----
mkdir -p "$WALLETS_DIR"

# ---- Start validator in background ----
echo "Starting local Solana validator..."
echo "  RPC:    http://localhost:8899"
echo "  Ledger: $LEDGER_DIR"
solana-test-validator --ledger "$LEDGER_DIR" --quiet &
VALIDATOR_PID=$!

cleanup() {
  echo ""
  echo "Shutting down validator (PID $VALIDATOR_PID)..."
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
  echo "Done."
}
trap cleanup INT TERM EXIT

# ---- Wait for validator to be ready ----
echo "Waiting for validator to be ready..."
for i in $(seq 1 30); do
  if curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result"'; then
    echo "Validator ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Error: Validator did not start within 30 seconds."
    exit 1
  fi
  sleep 1
done

# ---- Generate wallet if none exists ----
WALLET_COUNT=$(find "$WALLETS_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [ "$WALLET_COUNT" -eq 0 ]; then
  echo "No wallets found. Generating one with 10 SOL airdrop..."
  cd "$HELPERS_DIR" && npx tsx generate-wallet.ts
  cd "$SCRIPT_DIR"
fi

# ---- Start dashboard ----
echo ""
echo "Starting Kova Dashboard on http://localhost:3000"
echo "Press Ctrl+C to stop everything."
echo ""
cd "$SCRIPT_DIR" && npm run dev

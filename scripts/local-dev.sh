#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# kova — Local Development Setup
#
# One script to go from zero to a running local Solana environment
# with a funded wallet, ready to run any kova example.
#
# Usage:
#   ./scripts/local-dev.sh              # Interactive setup (prompts for everything)
#   ./scripts/local-dev.sh --quick      # Skip prompts, use defaults, launch validator
#   ./scripts/local-dev.sh --stop       # Stop the running validator
#   ./scripts/local-dev.sh --status     # Check if validator is running
#
# What this script does:
#   1. Checks prerequisites (Node.js, npm, Solana CLI)
#   2. Installs Solana CLI if missing (with your permission)
#   3. Installs npm dependencies if needed
#   4. Builds the kova SDK
#   5. Generates a local keypair (or reuses existing)
#   6. Starts solana-test-validator in the background
#   7. Funds the keypair with SOL via airdrop
#   8. Optionally collects Telegram / Anthropic credentials
#   9. Writes a .env.local file with all config
#  10. Runs a smoke test to verify everything works
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors & Helpers ─────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }

# ── Project Root ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

LOCAL_KEYPAIR="$PROJECT_ROOT/.local-keypair.json"
ENV_FILE="$PROJECT_ROOT/.env.local"
VALIDATOR_LOG="$PROJECT_ROOT/.validator.log"
VALIDATOR_PID_FILE="$PROJECT_ROOT/.validator.pid"
RPC_URL="http://localhost:8899"
AIRDROP_AMOUNT=100

# ── Flags ────────────────────────────────────────────────────────────────────

QUICK_MODE=false
STOP_MODE=false
STATUS_MODE=false

for arg in "$@"; do
  case "$arg" in
    --quick)  QUICK_MODE=true ;;
    --stop)   STOP_MODE=true ;;
    --status) STATUS_MODE=true ;;
    --help|-h)
      echo "Usage: $0 [--quick|--stop|--status|--help]"
      echo ""
      echo "  --quick   Skip prompts, use defaults, launch validator"
      echo "  --stop    Stop the running local validator"
      echo "  --status  Check if the validator is running"
      echo "  --help    Show this help message"
      exit 0
      ;;
    *)
      error "Unknown flag: $arg"
      echo "Run '$0 --help' for usage."
      exit 1
      ;;
  esac
done

# ── Stop Mode ────────────────────────────────────────────────────────────────

stop_validator() {
  if [[ -f "$VALIDATOR_PID_FILE" ]]; then
    local pid
    pid=$(cat "$VALIDATOR_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      info "Stopping solana-test-validator (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      # Wait up to 5 seconds for clean shutdown
      for i in {1..10}; do
        if ! kill -0 "$pid" 2>/dev/null; then
          break
        fi
        sleep 0.5
      done
      # Force kill if still running
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      success "Validator stopped."
    else
      warn "Validator process $pid is not running."
    fi
    rm -f "$VALIDATOR_PID_FILE"
  else
    # Try to find and kill any running solana-test-validator
    local pids
    pids=$(pgrep -f "solana-test-validator" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      info "Found running validator(s): $pids"
      echo "$pids" | xargs kill 2>/dev/null || true
      success "Validator(s) stopped."
    else
      info "No running validator found."
    fi
  fi
}

if $STOP_MODE; then
  stop_validator
  exit 0
fi

# ── Status Mode ──────────────────────────────────────────────────────────────

if $STATUS_MODE; then
  if [[ -f "$VALIDATOR_PID_FILE" ]] && kill -0 "$(cat "$VALIDATOR_PID_FILE")" 2>/dev/null; then
    success "Validator is running (PID $(cat "$VALIDATOR_PID_FILE"))"
    info "RPC URL: $RPC_URL"
    # Quick health check
    if curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q "ok" 2>/dev/null; then
      success "Validator is healthy and responding."
    else
      warn "Validator process exists but RPC is not responding."
    fi
  else
    info "No validator is running."
  fi
  exit 0
fi

# ── Banner ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}"
echo "  ┌─────────────────────────────────────────────┐"
echo "  │          kova — Local Dev Setup              │"
echo "  │   Policy-constrained wallet for AI agents    │"
echo "  └─────────────────────────────────────────────┘"
echo -e "${NC}"

# ── Step 1: Check Prerequisites ─────────────────────────────────────────────

step "Step 1/8: Checking prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    success "Node.js $NODE_VERSION"
  else
    error "Node.js >= 18 required, found $NODE_VERSION"
    echo "  Install via: https://nodejs.org/ or 'nvm install 18'"
    exit 1
  fi
else
  error "Node.js is not installed."
  echo "  Install via: https://nodejs.org/ or 'nvm install 18'"
  exit 1
fi

# npm
if command -v npm &>/dev/null; then
  success "npm $(npm -v)"
else
  error "npm is not installed."
  exit 1
fi

# Solana CLI
if command -v solana &>/dev/null; then
  SOLANA_VERSION=$(solana --version 2>/dev/null | head -1)
  success "Solana CLI: $SOLANA_VERSION"
else
  warn "Solana CLI is not installed."
  echo ""
  echo "  The Solana CLI provides the local test validator and wallet tools."
  echo ""

  INSTALL_SOLANA=false
  if $QUICK_MODE; then
    INSTALL_SOLANA=true
  else
    read -rp "  Install Solana CLI now? (y/n): " answer
    [[ "$answer" =~ ^[Yy] ]] && INSTALL_SOLANA=true
  fi

  if $INSTALL_SOLANA; then
    info "Installing Solana CLI (this may take a minute)..."
    sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" 2>&1 | tail -3

    # Add to PATH for this session
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

    if command -v solana &>/dev/null; then
      success "Solana CLI installed: $(solana --version 2>/dev/null | head -1)"
      echo ""
      warn "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
      echo '  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'
      echo ""
    else
      error "Solana CLI installation failed."
      echo "  Try manually: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
      exit 1
    fi
  else
    error "Solana CLI is required for the local validator."
    echo "  Install manually:"
    echo "    sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
    exit 1
  fi
fi

# solana-test-validator specifically
if ! command -v solana-test-validator &>/dev/null; then
  error "solana-test-validator not found in PATH."
  echo "  It should be part of the Solana CLI installation."
  echo "  Make sure ~/.local/share/solana/install/active_release/bin is in your PATH."
  exit 1
fi

success "solana-test-validator found"

# ── Step 2: Install npm Dependencies ────────────────────────────────────────

step "Step 2/8: Installing npm dependencies"

if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
  success "node_modules already exists"
else
  info "Running npm install..."
  npm install
  success "Dependencies installed"
fi

# Check for tsx (needed to run examples)
if ! npx tsx --version &>/dev/null 2>&1; then
  info "Installing tsx (TypeScript executor for examples)..."
  npm install -D tsx
  success "tsx installed"
else
  success "tsx available"
fi

# ── Step 3: Build the SDK ───────────────────────────────────────────────────

step "Step 3/8: Building kova SDK"

info "Running npm run build..."
npm run build 2>&1 | tail -1
success "SDK built (dist/ ready)"

# ── Step 4: Generate Keypair ────────────────────────────────────────────────

step "Step 4/8: Setting up local keypair"

if [[ -f "$LOCAL_KEYPAIR" ]]; then
  WALLET_ADDRESS=$(solana-keygen pubkey "$LOCAL_KEYPAIR" 2>/dev/null)
  success "Reusing existing keypair: $WALLET_ADDRESS"
  info "Location: $LOCAL_KEYPAIR"
else
  info "Generating new keypair..."
  solana-keygen new --outfile "$LOCAL_KEYPAIR" --no-bip39-passphrase --force --silent 2>/dev/null
  WALLET_ADDRESS=$(solana-keygen pubkey "$LOCAL_KEYPAIR")
  success "Keypair generated: $WALLET_ADDRESS"
  info "Location: $LOCAL_KEYPAIR"
fi

# ── Step 5: Start Validator ─────────────────────────────────────────────────

step "Step 5/8: Starting solana-test-validator"

# Check if already running
ALREADY_RUNNING=false
if [[ -f "$VALIDATOR_PID_FILE" ]] && kill -0 "$(cat "$VALIDATOR_PID_FILE")" 2>/dev/null; then
  ALREADY_RUNNING=true
  success "Validator already running (PID $(cat "$VALIDATOR_PID_FILE"))"
elif curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
  ALREADY_RUNNING=true
  success "Validator already running on $RPC_URL"
fi

if ! $ALREADY_RUNNING; then
  # Clean up stale ledger data that can cause startup issues
  LEDGER_DIR="$PROJECT_ROOT/test-ledger"
  if [[ -d "$LEDGER_DIR" ]]; then
    info "Cleaning stale ledger data..."
    rm -rf "$LEDGER_DIR"
  fi

  info "Starting validator in background..."
  info "Log file: $VALIDATOR_LOG"

  solana-test-validator \
    --ledger "$LEDGER_DIR" \
    --rpc-port 8899 \
    --quiet \
    > "$VALIDATOR_LOG" 2>&1 &

  VALIDATOR_PID=$!
  echo "$VALIDATOR_PID" > "$VALIDATOR_PID_FILE"

  # Wait for validator to be ready (up to 30 seconds)
  info "Waiting for validator to start..."
  RETRIES=0
  MAX_RETRIES=60
  while [[ $RETRIES -lt $MAX_RETRIES ]]; do
    if curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
      break
    fi

    # Check if process died
    if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      error "Validator process exited unexpectedly."
      echo "  Check logs: cat $VALIDATOR_LOG"
      exit 1
    fi

    sleep 0.5
    RETRIES=$((RETRIES + 1))
  done

  if [[ $RETRIES -ge $MAX_RETRIES ]]; then
    error "Validator did not start within 30 seconds."
    echo "  Check logs: cat $VALIDATOR_LOG"
    exit 1
  fi

  success "Validator running (PID $VALIDATOR_PID)"
fi

info "RPC URL: $RPC_URL"

# ── Step 6: Fund the Wallet ─────────────────────────────────────────────────

step "Step 6/8: Funding wallet"

info "Airdropping $AIRDROP_AMOUNT SOL to $WALLET_ADDRESS..."

# Configure solana CLI for local
solana config set --url "$RPC_URL" --keypair "$LOCAL_KEYPAIR" >/dev/null 2>&1

# Airdrop in chunks (local validator usually allows large amounts but let's be safe)
REMAINING=$AIRDROP_AMOUNT
CHUNK=10
while [[ $REMAINING -gt 0 ]]; do
  AMOUNT=$CHUNK
  if [[ $REMAINING -lt $CHUNK ]]; then
    AMOUNT=$REMAINING
  fi
  if solana airdrop "$AMOUNT" "$WALLET_ADDRESS" --url "$RPC_URL" >/dev/null 2>&1; then
    REMAINING=$((REMAINING - AMOUNT))
  else
    warn "Airdrop of $AMOUNT SOL failed. Trying smaller amount..."
    if solana airdrop 2 "$WALLET_ADDRESS" --url "$RPC_URL" >/dev/null 2>&1; then
      REMAINING=$((REMAINING - 2))
    else
      warn "Airdrop failed, continuing with current balance."
      break
    fi
  fi
done

BALANCE=$(solana balance "$WALLET_ADDRESS" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
success "Wallet balance: $BALANCE SOL"

# ── Step 7: Collect Optional Credentials ────────────────────────────────────

step "Step 7/8: Optional integrations"

ANTHROPIC_API_KEY=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""

# Load existing .env.local if it exists
if [[ -f "$ENV_FILE" ]]; then
  info "Found existing $ENV_FILE — loading values as defaults."
  # shellcheck disable=SC1090
  source "$ENV_FILE" 2>/dev/null || true
fi

if ! $QUICK_MODE; then
  echo ""
  echo "  These are optional. Press Enter to skip any."
  echo ""

  # Anthropic API key
  read -rp "  Anthropic API key (for Claude agent example) [${ANTHROPIC_API_KEY:+****${ANTHROPIC_API_KEY: -4}}]: " input
  if [[ -n "$input" ]]; then
    ANTHROPIC_API_KEY="$input"
  fi

  # Telegram bot token
  read -rp "  Telegram bot token (for approval example) [${TELEGRAM_BOT_TOKEN:+****${TELEGRAM_BOT_TOKEN: -6}}]: " input
  if [[ -n "$input" ]]; then
    TELEGRAM_BOT_TOKEN="$input"
  fi

  # Telegram chat ID
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    read -rp "  Telegram chat ID [${TELEGRAM_CHAT_ID:-}]: " input
    if [[ -n "$input" ]]; then
      TELEGRAM_CHAT_ID="$input"
    fi
  fi
else
  info "Quick mode — skipping optional credentials."
  info "Edit $ENV_FILE later to add API keys."
fi

# Write .env.local
cat > "$ENV_FILE" << EOF
# ──────────────────────────────────────────────────────────────────────────────
# kova — Local Development Environment
# Generated by scripts/local-dev.sh on $(date '+%Y-%m-%d %H:%M:%S')
# ──────────────────────────────────────────────────────────────────────────────

# Solana local validator
SOLANA_RPC_URL=$RPC_URL

# Wallet keypair (auto-generated, funded with SOL)
LOCAL_KEYPAIR_PATH=$LOCAL_KEYPAIR
WALLET_ADDRESS=$WALLET_ADDRESS

# Recipient for test transfers (System Program address — safe to send to)
RECIPIENT_ADDRESS=11111111111111111111111111111111

# ── Optional: Claude Agent Example ───────────────────────────────────────────
# Get a key at https://console.anthropic.com/
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}

# ── Optional: Telegram Approval Example ──────────────────────────────────────
# 1. Message @BotFather on Telegram → /newbot → copy token
# 2. Send a message to your bot, then visit:
#    https://api.telegram.org/bot<TOKEN>/getUpdates
#    to find your chat ID in the response JSON
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
EOF

success "Config written to $ENV_FILE"

# ── Step 8: Smoke Test ──────────────────────────────────────────────────────

step "Step 8/8: Smoke test"

info "Running policy playground (no blockchain needed)..."
if npx tsx examples/policy-playground/index.ts 2>&1 | tail -5; then
  success "Policy playground works"
else
  warn "Policy playground had issues (non-fatal)"
fi

echo ""
info "Testing RPC connection..."
SLOT=$(curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | grep -o '"result":[0-9]*' | cut -d: -f2)
if [[ -n "$SLOT" ]]; then
  success "RPC responding — current slot: $SLOT"
else
  warn "RPC health check failed (validator may still be starting)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}"
echo "  ┌─────────────────────────────────────────────┐"
echo "  │           Setup Complete!                    │"
echo "  └─────────────────────────────────────────────┘"
echo -e "${NC}"

echo -e "  ${BOLD}Validator${NC}"
echo "    RPC URL:        $RPC_URL"
echo "    Wallet:         $WALLET_ADDRESS"
echo "    Balance:        ${BALANCE:-?} SOL"
echo "    Validator log:  $VALIDATOR_LOG"
echo ""
echo -e "  ${BOLD}Run Examples${NC}"
echo ""
echo "    # Load environment variables first:"
echo -e "    ${CYAN}source $ENV_FILE${NC}"
echo ""
echo "    # Policy playground (no blockchain needed):"
echo -e "    ${CYAN}npx tsx examples/policy-playground/index.ts${NC}"
echo ""
echo "    # Basic transfer (uses local validator):"
echo -e "    ${CYAN}npx tsx examples/basic-transfer/index.ts${NC}"
echo ""

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "    # Claude agent (uses local validator + Anthropic API):"
  echo -e "    ${CYAN}npx tsx examples/claude-agent/index.ts${NC}"
  echo ""
fi

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "    # Telegram approval (uses local validator + Telegram bot):"
  echo -e "    ${CYAN}npx tsx examples/telegram-approval/index.ts${NC}"
  echo ""
fi

echo -e "  ${BOLD}Manage Validator${NC}"
echo ""
echo "    # Check status:"
echo -e "    ${CYAN}./scripts/local-dev.sh --status${NC}"
echo ""
echo "    # Stop validator:"
echo -e "    ${CYAN}./scripts/local-dev.sh --stop${NC}"
echo ""
echo "    # View validator logs:"
echo -e "    ${CYAN}tail -f $VALIDATOR_LOG${NC}"
echo ""
echo -e "  ${BOLD}Run Unit Tests${NC} (no validator needed)"
echo -e "    ${CYAN}npm test${NC}"
echo ""

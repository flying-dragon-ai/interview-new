#!/usr/bin/env bash
set -euo pipefail

for tool in alchemy; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required command: $tool" >&2; exit 1; }
done

if command -v forge >/dev/null 2>&1; then FORGE=(forge); else FORGE=(pnpm dlx @foundry-rs/forge); fi
if command -v cast >/dev/null 2>&1; then CAST=(cast); else CAST=(pnpm dlx @foundry-rs/cast); fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACTS_DIR="$PROJECT_DIR/contracts"
RPC_URL="https://testnet-rpc.monad.xyz"
FACTORY="0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
SALT="${INTERVIEW_CREDENTIAL_SALT:-0x0000000000000000000000000000000000000000000000000000000000000000}"

alchemy auth status >/dev/null
alchemy wallet status --verify
CHAIN_ID="$("${CAST[@]}" chain-id --rpc-url "$RPC_URL")"
if [[ "$CHAIN_ID" != "10143" ]]; then
  echo "Expected Monad Testnet chain id 10143, received $CHAIN_ID" >&2
  exit 1
fi
FACTORY_CODE="$("${CAST[@]}" code "$FACTORY" --rpc-url "$RPC_URL")"
if [[ "$FACTORY_CODE" == "0x" ]]; then
  echo "CreateX factory has no code on Monad Testnet; refusing deployment." >&2
  exit 1
fi

cd "$CONTRACTS_DIR"
"${FORGE[@]}" build
CREATION_CODE="$("${FORGE[@]}" inspect src/InterviewCredential.sol:InterviewCredential bytecode)"
INIT_CODE="$CREATION_CODE"
INIT_CODE_HASH="$("${CAST[@]}" keccak "$INIT_CODE")"
PREDICTED="$("${CAST[@]}" call "$FACTORY" \
  'computeCreate2Address(bytes32,bytes32)(address)' "$SALT" "$INIT_CODE_HASH" \
  --rpc-url "$RPC_URL")"
EXISTING_CODE="$("${CAST[@]}" code "$PREDICTED" --rpc-url "$RPC_URL")"
if [[ "$EXISTING_CODE" != "0x" ]]; then
  echo "Predicted address already contains code: $PREDICTED" >&2
  echo "Set INTERVIEW_CREDENTIAL_SALT to a new bytes32 salt and retry." >&2
  exit 1
fi

echo "Network: Monad Testnet (10143)"
echo "Predicted contract: $PREDICTED"
echo "The next command sends a deployment transaction from the active Alchemy Agent Wallet session."
alchemy evm contract call "$FACTORY" 'deployCreate2(bytes32,bytes)' \
  --args "$SALT,$INIT_CODE" -n monad-testnet
echo "After the call confirms, verify code at $PREDICTED and set VITE_INTERVIEW_CREDENTIAL_ADDRESS=$PREDICTED"

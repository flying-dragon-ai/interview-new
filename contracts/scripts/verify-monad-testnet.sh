#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${INTERVIEW_CREDENTIAL_ADDRESS:-}" ]]; then
  echo "Set INTERVIEW_CREDENTIAL_ADDRESS to the deployed contract address." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACTS_DIR="$PROJECT_DIR/contracts"
if command -v forge >/dev/null 2>&1; then FORGE=(forge); else FORGE=(pnpm dlx @foundry-rs/forge); fi
if command -v jq >/dev/null 2>&1; then JQ=(jq); else echo "Missing required command: jq" >&2; exit 1; fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
cd "$CONTRACTS_DIR"
"${FORGE[@]}" build
"${FORGE[@]}" verify-contract "$INTERVIEW_CREDENTIAL_ADDRESS" \
  src/InterviewCredential.sol:InterviewCredential \
  --chain 10143 --show-standard-json-input > "$TEMP_DIR/standard-input.json"

ARTIFACT="out/InterviewCredential.sol/InterviewCredential.json"
METADATA="$("${JQ[@]}" -c '.metadata | if type == "string" then fromjson else . end' "$ARTIFACT")"
COMPILER="$("${JQ[@]}" -r '.compiler.version' <<< "$METADATA")"
COMPILER_VERSION="v${COMPILER}"
STANDARD_INPUT="$(<"$TEMP_DIR/standard-input.json")"
REQUEST="$("${JQ[@]}" -n \
  --arg chainId "10143" \
  --arg contractAddress "$INTERVIEW_CREDENTIAL_ADDRESS" \
  --arg contractName "src/InterviewCredential.sol:InterviewCredential" \
  --arg compilerVersion "$COMPILER_VERSION" \
  --argjson standardJsonInput "$STANDARD_INPUT" \
  --argjson foundryMetadata "$METADATA" \
  '{chainId: ($chainId|tonumber), contractAddress: $contractAddress, contractName: $contractName, compilerVersion: $compilerVersion, standardJsonInput: $standardJsonInput, foundryMetadata: $foundryMetadata}')"

curl --fail-with-body --silent --show-error -X POST https://agents.devnads.com/v1/verify \
  -H 'Content-Type: application/json' \
  --data "$REQUEST"
printf '\n'

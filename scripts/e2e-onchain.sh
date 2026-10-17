#!/usr/bin/env bash
# E2E：面试报告上链功能全链路本地验证（anvil + 前端同款 reportHash）
# 覆盖：哈希计算 → 部署 → 付费铸证 → 查重/验真 → 事件形状（索引器输入）
#       → soulbound → 重复铸造 → 欠费 → 超额 → withdraw 归集 → gas 实测
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
RPC=http://127.0.0.1:8545

KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0 deployer/owner
KEY1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # anvil #1 treasury
KEY2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a # anvil #2 minter
KEY3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 # anvil #3 第三方
A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
A3=0x90F79bf6EB2c4f870365E785982E1f101E93b906

SIG_SOULBOUND=$(cast sig "SoulboundTransfer()")
SIG_DUP=$(cast sig "ReportAlreadyMinted(bytes32,uint256)")
SIG_UNDERPAY=$(cast sig "InsufficientPayment(uint256,uint256)")

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1 → $2"; else bad "$1 期望[$3] 实际[$2]"; fi; }
first() { echo "$1" | awk '{print $1}'; }   # cast call 会附带 [1e16] 之类注解，取首 token
revert_check() { # $1 描述  $2 期望 selector  $3 原始输出
  if echo "$3" | grep -qi "revert"; then
    if echo "$3" | grep -qi "${2#0x}"; then ok "$1 → revert（自定义错误 $2）"
    else ok "$1 → revert"; echo "    $(echo "$3" | grep -i revert | head -1 | cut -c1-110)"; fi
  else bad "$1 未被拒：$(echo "$3" | tail -1 | cut -c1-110)"; fi
}

anvil --port 8545 --silent > .e2e-anvil.log 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT
for _ in $(seq 1 40); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.25; done
cast block-number --rpc-url $RPC >/dev/null 2>&1 || { echo "anvil 未就绪，看 tmp/anvil.log"; exit 1; }

echo "── 1. 前端同款 reportHash 计算 ──"
OUT=$(node scripts/e2e-report-hash.mjs "$(echo $A2 | tr 'A-F' 'a-f')")
HASH=$(echo "$OUT" | sed -n 's/^HASH=//p')
echo "$OUT" | sed -n 's/^CANONICAL=//p' | head -c 240; echo " …"
if [[ "$HASH" =~ ^0x[0-9a-f]{64}$ ]]; then ok "reportHash = $HASH"; else bad "reportHash 格式异常: $HASH"; exit 1; fi

echo "── 2. 部署（mintPrice=0.01，treasury=acct1） ──"
DEPLOY=$(cd contracts && forge create src/InterviewCertificate.sol:InterviewCertificate \
  --rpc-url $RPC --private-key $KEY0 --broadcast \
  --constructor-args 10000000000000000 $A1 2>&1)
CERT=$(echo "$DEPLOY" | sed -n 's/^Deployed to: //p')
if [[ "$CERT" =~ ^0x[0-9a-fA-F]{40}$ ]]; then ok "部署 $CERT"; else echo "$DEPLOY" | tail -6; bad "部署失败"; exit 1; fi

echo "── 3. 付费铸证（minter=acct2，付 0.01） ──"
TX=$(cast send $CERT "mintCertificate(bytes32)" $HASH --value 0.01ether \
  --rpc-url $RPC --private-key $KEY2 2>/dev/null | awk '/^transactionHash/{print $2}')
[[ "$TX" =~ ^0x[0-9a-f]{64}$ ]] && ok "tx $TX" || { bad "铸证交易未发出"; exit 1; }
check "receipt status" "$(cast receipt $TX --rpc-url $RPC | awk '/^status/{print $2}')" "1"
check "certificateOfReport(hash)" "$(cast call $CERT "certificateOfReport(bytes32)(uint256)" $HASH --rpc-url $RPC)" "1"
check "nextTokenId" "$(cast call $CERT "nextTokenId()(uint256)" --rpc-url $RPC)" "2"
check "ownerOf(1)" "$(cast call $CERT "ownerOf(uint256)(address)" 1 --rpc-url $RPC | awk '{print tolower($1)}')" "$(echo $A2 | tr 'A-F' 'a-f')"
check "verifyReport 正例" "$(cast call $CERT "verifyReport(uint256,bytes32)(bool)" 1 $HASH --rpc-url $RPC)" "true"
check "verifyReport 反例" "$(cast call $CERT "verifyReport(uint256,bytes32)(bool)" 1 0x0000000000000000000000000000000000000000000000000000000000000001 --rpc-url $RPC)" "false"
check "mintPrice" "$(first "$(cast call $CERT "mintPrice()(uint256)" --rpc-url $RPC)")" "10000000000000000"

echo "── 4. 事件形状（Envio 索引器的输入；注意过滤掉 ERC721 Transfer 日志） ──"
cast receipt $TX --rpc-url $RPC --json > .e2e-receipt.json 2>/dev/null
EXPECTED_TOPIC0=$(cast keccak "CertificateMinted(uint256,address,bytes32,uint256)")
EVINFO=$(EXPECTED_TOPIC0=$EXPECTED_TOPIC0 HASH=$HASH node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(".e2e-receipt.json", "utf8"));
const l = (r.logs || []).find((x) => x.topics[0] === process.env.EXPECTED_TOPIC0);
if (!l) { console.log("NO_CERT_EVENT"); process.exit(0); }
console.log([
  "topics=" + l.topics.length,
  "tokenId=" + BigInt(l.topics[1]).toString(),
  "recipient=0x" + l.topics[2].slice(26).toLowerCase(),
  "reportHash=" + l.topics[3],
  "paidAmount=" + BigInt(l.data).toString(),
].join(" "));
')
echo "  $EVINFO"
if echo "$EVINFO" | grep -q "NO_CERT_EVENT"; then bad "receipt 中无 CertificateMinted 事件"
else
  echo "$EVINFO" | grep -q "topics=4" && ok "3 个 indexed 字段 + topic0" || bad "indexed 字段数不对"
  echo "$EVINFO" | grep -q "tokenId=1" && ok "tokenId=1" || bad "tokenId 不对"
  echo "$EVINFO" | grep -q "recipient=$(echo $A2 | tr 'A-F' 'a-f')" && ok "recipient=minter" || bad "recipient 不对"
  echo "$EVINFO" | grep -q "reportHash=$HASH" && ok "reportHash 与前端计算一致" || bad "reportHash 不一致"
  echo "$EVINFO" | grep -q "paidAmount=10000000000000000" && ok "data=paidAmount 0.01" || bad "paidAmount 不对"
fi

echo "── 5. soulbound：转让必须被拒 ──"
OUT=$(cast send $CERT "transferFrom(address,address,uint256)" $A2 $A3 1 --rpc-url $RPC --private-key $KEY2 2>&1)
revert_check "transferFrom" "$SIG_SOULBOUND" "$OUT"
OUT=$(cast send $CERT "safeTransferFrom(address,address,uint256)" $A2 $A3 1 --rpc-url $RPC --private-key $KEY2 2>&1)
revert_check "safeTransferFrom" "$SIG_SOULBOUND" "$OUT"

echo "── 6. 同一报告重复铸造必须被拒 ──"
OUT=$(cast send $CERT "mintCertificate(bytes32)" $HASH --value 0.01ether --rpc-url $RPC --private-key $KEY3 2>&1)
revert_check "重复铸造（acct3 用同一 hash）" "$SIG_DUP" "$OUT"

echo "── 7. 欠费 revert / 超额接受 ──"
HASH2=$(cast keccak "second-report-payload")
OUT=$(cast send $CERT "mintCertificate(bytes32)" $HASH2 --value 0.005ether --rpc-url $RPC --private-key $KEY3 2>&1)
revert_check "欠费（0.005 < 0.01）" "$SIG_UNDERPAY" "$OUT"
TX2=$(cast send $CERT "mintCertificate(bytes32)" $HASH2 --value 0.02ether --rpc-url $RPC --private-key $KEY3 2>/dev/null | awk '/^transactionHash/{print $2}')
check "超额铸造（0.02）status" "$(cast receipt $TX2 --rpc-url $RPC | awk '/^status/{print $2}')" "1"

echo "── 8. withdraw 归集到 treasury ──"
B1=$(cast balance $A1 --rpc-url $RPC)
cast send $CERT "withdraw()" --rpc-url $RPC --private-key $KEY3 >/dev/null 2>&1   # 第三方也可触发
B2=$(cast balance $A1 --rpc-url $RPC)
DIFF=$(node -e "console.log((BigInt('$B2') - BigInt('$B1')).toString())")
check "treasury 增量（0.01+0.02）" "$DIFF" "30000000000000000"
check "合约余额清零" "$(cast balance $CERT --rpc-url $RPC)" "0"

echo "── 9. gas 实测（对比 forge 单测 113,337） ──"
GAS=$(cast receipt $TX --rpc-url $RPC | awk '/^gasUsed/{print $2}' | tr -d ',')
echo "  mintCertificate gasUsed = $GAS（Monad 冷存储更贵；前端 limit 策略 = estimateGas+10%，兜底 200,000）"

echo
echo "════ 结果：✅ $PASS 通过 / ❌ $FAIL 失败 ════"
[ "$FAIL" -eq 0 ]

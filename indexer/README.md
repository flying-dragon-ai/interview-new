# indexer/ — Envio HyperIndex（InterviewCertificate 事件索引）

本目录由 envio CLI 生成内容填充。**硬前置**：合约已部署且在浏览器验证通过
（contract-import 从浏览器拉 ABI），见 `docs/monad-onchain.md` 第 1-2 节。

```bash
# CLI 前置（只能 operator 本人执行）：
#   npm install -g envio-cloud && envio-cloud login
#   gh auth login
pnpx envio@3.0.0-alpha.21 init contract-import explorer \
  -b monad-testnet -c <CERT_ADDRESS> -n InterviewCertificate \
  -l typescript -d ./ -o ./ --all-events --single-contract --api-token ""
```

init 后的三处修改（field_selection / schema / handler）与 Envio Cloud 部署流程，
完整命令见 `docs/monad-onchain.md` 第 3 节。前端消费端：`components/CertificateSection.tsx`
（`VITE_ENVIO_GRAPHQL_URL` 未配置时证书列表整段隐藏）。

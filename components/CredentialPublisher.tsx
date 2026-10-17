import React, { useMemo, useState } from 'react';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'wagmi/chains';
import { createAssessmentProof, SKILL_TAGS, verifyAssessmentProof } from '../src/onchain/assessmentProof';
import { INTERVIEW_CREDENTIAL_ABI, INTERVIEW_CREDENTIAL_ADDRESS, MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_EXPLORER } from '../src/onchain/config';
import { useWalletIdentity } from '../src/wallet/context';
import { recordOnchainAssessment } from '../src/api';
import type { ReportV15 } from '../types';

interface CredentialPublisherProps {
  report: ReportV15;
  sessionId: number | null;
}

type PublishState =
  | { status: 'idle' }
  | { status: 'switching' }
  | { status: 'submitting' }
  | { status: 'confirmed'; txHash: string; tokenId: string | null; persisted: boolean }
  | { status: 'error'; message: string };

const CredentialPublisher: React.FC<CredentialPublisherProps> = ({ report, sessionId }) => {
  const wallet = useWalletIdentity();
  const proof = useMemo(() => createAssessmentProof(report), [report]);
  const [consent, setConsent] = useState(false);
  const [localSaved, setLocalSaved] = useState(false);
  const [proofCheck, setProofCheck] = useState<string | null>(null);
  const [state, setState] = useState<PublishState>({ status: 'idle' });

  const saveLocally = () => {
    try {
      localStorage.setItem(`interview-credential-proof:${proof.sessionHash}`, JSON.stringify({
        ...proof,
        sessionId,
        savedAt: new Date().toISOString(),
      }, null, 2));
      setLocalSaved(true);
    } catch {
      setState({ status: 'error', message: '浏览器本地存储不可用，请下载验证文件保存。' });
    }
  };

  const downloadProof = () => {
    const artifact = state.status === 'confirmed'
      ? { ...proof, tokenId: state.tokenId, transactionHash: state.txHash }
      : proof;
    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `interview-proof-${proof.sessionHash.slice(2, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const verifyFile = async (file?: File) => {
    if (!file) return;
    try {
      const contents: unknown = JSON.parse(await file.text());
      const valid = verifyAssessmentProof(contents as Parameters<typeof verifyAssessmentProof>[0]);
      if (!valid) {
        setProofCheck('验证失败：文件字段或摘要哈希不匹配。');
        return;
      }
      const artifact = contents as Parameters<typeof verifyAssessmentProof>[0] & { tokenId?: string; transactionHash?: string };
      if (!artifact.tokenId || !INTERVIEW_CREDENTIAL_ADDRESS) {
        setProofCheck('本地哈希验证通过；文件没有凭证 Token ID，暂不能与链上记录比对。');
        return;
      }
      const publicClient = createPublicClient({ chain: monadTestnet, transport: http('https://testnet-rpc.monad.xyz') });
      const assessmentId = await (publicClient as any).readContract({
        address: INTERVIEW_CREDENTIAL_ADDRESS,
        abi: INTERVIEW_CREDENTIAL_ABI,
        functionName: 'assessmentByToken',
        args: [BigInt(artifact.tokenId)],
      });
      const assessment = await (publicClient as any).readContract({
        address: INTERVIEW_CREDENTIAL_ADDRESS,
        abi: INTERVIEW_CREDENTIAL_ABI,
        functionName: 'assessments',
        args: [assessmentId],
      });
      const chainMatches = assessment[0].toLowerCase() === artifact.sessionHash.toLowerCase()
        && assessment[1].toLowerCase() === artifact.scoreHash.toLowerCase()
        && Number(assessment[2]) === artifact.scoreSummary.overallScore
        && assessment[5];
      setProofCheck(chainMatches ? `验证通过：本地摘要与 Monad 上的 Token #${artifact.tokenId} 相符。` : '链上核验失败：文件摘要与合约记录不匹配。');
    } catch {
      setProofCheck('验证失败：文件不是有效的凭证证明 JSON。');
    }
  };

  const publish = async () => {
    if (!consent) return;
    if (!wallet.configured) {
      setState({ status: 'error', message: '钱包服务尚未配置。设置 VITE_PARA_API_KEY 后即可连接钱包。' });
      return;
    }
    if (!INTERVIEW_CREDENTIAL_ADDRESS) {
      setState({ status: 'error', message: '尚未配置合约地址。请先部署 InterviewCredential 并设置 VITE_INTERVIEW_CREDENTIAL_ADDRESS。' });
      return;
    }
    try {
      if (!wallet.isConnected || !wallet.address) {
        setState({ status: 'switching' });
        await wallet.connect();
        setState({ status: 'idle' });
        return;
      }
      const contractAddress = INTERVIEW_CREDENTIAL_ADDRESS;
      if (wallet.chainId !== MONAD_TESTNET_CHAIN_ID) {
        setState({ status: 'switching' });
        await wallet.switchToMonadTestnet();
      }
      setState({ status: 'submitting' });
      const result = await wallet.issueCredential({
        sessionHash: proof.sessionHash,
        scoreHash: proof.scoreHash,
        overallScore: report.overall_score,
        skillHashes: proof.skillHashes,
      });
      const persisted = await recordOnchainAssessment({
        sessionId,
        walletAddress: wallet.address,
        sessionHash: proof.sessionHash,
        scoreHash: proof.scoreHash,
        overallScore: report.overall_score,
        skillHashes: proof.skillHashes,
        chainId: MONAD_TESTNET_CHAIN_ID,
        contractAddress,
        txHash: result.txHash,
        tokenId: result.tokenId,
      });
      setState({ status: 'confirmed', txHash: result.txHash, tokenId: result.tokenId, persisted });
    } catch (error) {
      const message = error instanceof Error ? error.message : '交易提交失败';
      setState({ status: 'error', message: /reject|denied|cancel/i.test(message) ? '你取消了钱包签名，本次没有发布。' : message });
    }
  };

  const busy = state.status === 'switching' || state.status === 'submitting';

  return (
    <section className="mb-8 rounded-2xl border border-slate-800 bg-[#171717] p-5 text-white md:p-6" aria-labelledby="credential-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[.18em] text-[#dfff00]">Monad · Interview Credential</p>
          <h3 id="credential-title" className="mt-2 text-xl font-black">保存或发布能力凭证</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
            凭证用于验证这份能力摘要是否被修改。原始对话、公司名称、音频和完整报告不会写入链上。
          </p>
        </div>
        <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">
          {wallet.isConnected && wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : '无需钱包即可练习'}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-white/5 p-3">
          <div className="text-[11px] uppercase tracking-wider text-white/45">链上总分</div>
          <div className="mt-1 text-2xl font-black text-[#dfff00]">{report.overall_score}<span className="ml-1 text-sm text-white/50">/100</span></div>
        </div>
        <div className="rounded-xl bg-white/5 p-3 sm:col-span-2">
          <div className="text-[11px] uppercase tracking-wider text-white/45">能力标签（只上链标签哈希）</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {SKILL_TAGS.map((skill) => <span key={skill.key} className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-white/75">{skill.label}</span>)}
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-xl border border-white/10 bg-white/[.03] p-3">
        <summary className="cursor-pointer text-sm font-bold text-white/80">查看上链字段与摘要哈希</summary>
        <dl className="mt-3 space-y-2 break-all text-xs text-white/55">
          <div><dt className="inline text-white/80">网络：</dt><dd className="inline">Monad Testnet（Chain ID {MONAD_TESTNET_CHAIN_ID}）</dd></div>
          <div><dt className="inline text-white/80">合约：</dt><dd className="inline">{INTERVIEW_CREDENTIAL_ADDRESS ?? '待部署并配置'}</dd></div>
          <div><dt className="inline text-white/80">Session hash：</dt><dd className="inline">{proof.sessionHash}</dd></div>
          <div><dt className="inline text-white/80">Score hash：</dt><dd className="inline">{proof.scoreHash}</dd></div>
          <div><dt className="inline text-white/80">能力标签：</dt><dd className="inline">{proof.skillHashes.join(', ')}</dd></div>
          <div><dt className="inline text-white/80">公开字段：</dt><dd className="inline">钱包地址、总分、时间戳和上述哈希</dd></div>
        </dl>
      </details>

      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm leading-6 text-white/75">
        <input className="mt-1 accent-[#dfff00]" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>我确认发布上述字段到 Monad Testnet。链上记录公开可查，且不能删除；完整报告和聊天内容不上链。</span>
      </label>

      {state.status === 'error' && <p role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{state.message}</p>}
      {state.status === 'switching' && <p role="status" className="mt-3 text-sm text-[#dfff00]">正在请求钱包切换到 Monad Testnet…</p>}
      {state.status === 'submitting' && <p role="status" className="mt-3 text-sm text-[#dfff00]">等待钱包签名并确认交易…</p>}
      {state.status === 'confirmed' && (
        <div role="status" className="mt-4 rounded-xl border border-emerald-300/25 bg-emerald-300/10 p-3 text-sm text-emerald-100">
          <div className="font-bold">凭证已在 Monad Testnet 确认{state.tokenId ? ` · Token #${state.tokenId}` : ''}</div>
          <div className="mt-1 text-xs">{state.persisted ? '交易索引已同步保存。' : '交易已上链；数据库索引未同步，仍可下载本地验证文件。'}</div>
          <div className="mt-1 break-all font-mono text-xs text-emerald-100/70">交易：{state.txHash}</div>
          <a className="mt-2 inline-block font-bold underline" href={`${MONAD_TESTNET_EXPLORER}/tx/${state.txHash}`} target="_blank" rel="noreferrer">在 Monadscan 查看交易 ↗</a>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" onClick={saveLocally} className="rounded-xl border border-white/20 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10">
          {localSaved ? '摘要已保存到本地 ✓' : '仅保存摘要到本地'}
        </button>
        <button type="button" onClick={downloadProof} className="rounded-xl border border-white/20 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10">下载验证文件</button>
        <label className="cursor-pointer rounded-xl border border-white/20 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10">
          验证证明文件
          <input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { void verifyFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </label>
        {state.status !== 'confirmed' && (
          <button type="button" onClick={publish} disabled={!consent || busy} className="rounded-xl bg-[#dfff00] px-5 py-2.5 text-sm font-black text-black transition hover:bg-[#eaff66] disabled:cursor-not-allowed disabled:opacity-45">
            {busy ? '处理中…' : wallet.isConnected ? '确认并发布能力凭证' : '连接钱包并发布'}
          </button>
        )}
      </div>
      {proofCheck && <p role="status" className={`mt-3 text-sm ${proofCheck.startsWith('验证通过') ? 'text-emerald-200' : 'text-amber-200'}`}>{proofCheck}</p>}
    </section>
  );
};

export default CredentialPublisher;

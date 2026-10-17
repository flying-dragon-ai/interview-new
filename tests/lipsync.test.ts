import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LipSyncService, type SpectrumSource, type VisemeFrame } from '../services/lipsync.ts';

/**
 * M7 P3-3：LipSyncService 测试
 * - 合成频谱 → viseme 权重落在预期区间
 * - 包络钳制在 [0,1]（attack 30ms / release 120ms）
 * - 静音输入 → 权重 0
 * - setTimingSource 切换后走时间戳驱动（D3 升级接口不变）
 */

/** 可编程 fake 分析器：喂入合成的时域/频域数据 */
class FakeAnalyser implements SpectrumSource {
  fftSize = 1024;
  frequencyBinCount = 512;
  context = { sampleRate: 48000 };
  private freq = new Uint8Array(512);
  private time = new Uint8Array(1024).fill(128);

  getByteFrequencyData(array: Uint8Array): void {
    array.set(this.freq.subarray(0, array.length));
  }
  getByteTimeDomainData(array: Uint8Array): void {
    array.set(this.time.subarray(0, array.length));
  }

  /** 合成时域正弦（控制 RMS） */
  setSine(amp: number, periodSamples = 16): void {
    for (let i = 0; i < this.time.length; i++) {
      this.time[i] = Math.round(128 + amp * 127 * Math.sin((2 * Math.PI * i) / periodSamples));
    }
  }
  setSilence(): void {
    this.time.fill(128);
  }
  /** 合成频谱：在 [fromHz, toHz] 放能量 */
  setBandEnergy(fromHz: number, toHz: number, value: number): void {
    this.freq.fill(0);
    const hzPerBin = this.context.sampleRate / 2 / this.frequencyBinCount;
    const from = Math.floor(fromHz / hzPerBin);
    const to = Math.ceil(toHz / hzPerBin);
    for (let i = from; i <= to && i < this.freq.length; i++) this.freq[i] = value;
  }
}

test('静音输入 → 全部权重 0', () => {
  const a = new FakeAnalyser();
  a.setSilence();
  a.setBandEnergy(500, 1100, 255);
  const svc = new LipSyncService(a);
  const f = svc.update(16);
  assert.deepEqual(f, { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, jawOpen: 0 });
});

test('低中频（aa 带）合成频谱 → aa 为主导权重且 jawOpen>0', () => {
  const a = new FakeAnalyser();
  a.setSine(0.3);
  a.setBandEnergy(500, 1100, 220);
  const svc = new LipSyncService(a);
  // 多帧收敛（attack 30ms）
  let f: VisemeFrame = svc.update(16);
  for (let i = 0; i < 10; i++) f = svc.update(16);
  assert.ok(f.aa > 0.4, `aa 应为主导，实际 ${f.aa.toFixed(3)}`);
  assert.ok(f.aa > f.ee && f.aa > f.ih, 'aa 应高于高频带权重');
  assert.ok(f.jawOpen > 0.5, `jawOpen 应随 RMS 抬起，实际 ${f.jawOpen.toFixed(3)}`);
  for (const k of ['aa', 'ih', 'ou', 'ee', 'oh', 'jawOpen'] as const) {
    assert.ok(f[k] >= 0 && f[k] <= 1, `${k} 越界: ${f[k]}`);
  }
});

test('高频（ee 带）合成频谱 → ee/ih 权重显著高于 oh/ou', () => {
  const a = new FakeAnalyser();
  a.setSine(0.3);
  a.setBandEnergy(2400, 4800, 220);
  const svc = new LipSyncService(a);
  let f: VisemeFrame = svc.update(16);
  for (let i = 0; i < 10; i++) f = svc.update(16);
  assert.ok(f.ee > f.oh && f.ee > f.ou, `ee 应主导: ee=${f.ee.toFixed(3)} oh=${f.oh.toFixed(3)} ou=${f.ou.toFixed(3)}`);
});

test('包络：attack 快于 release；任何 dt 下权重钳制 [0,1]', () => {
  const a = new FakeAnalyser();
  const svc = new LipSyncService(a);
  // 大能量突增：attack 后 jawOpen 明显抬起但 ≤1
  a.setSine(0.9);
  a.setBandEnergy(150, 4800, 255);
  const f1 = svc.update(16);
  assert.ok(f1.jawOpen > 0 && f1.jawOpen <= 1);
  const f2 = svc.update(1000); // 超大 dt 也不越界
  for (const k of ['aa', 'ih', 'ou', 'ee', 'oh', 'jawOpen'] as const) {
    assert.ok(f2[k] >= 0 && f2[k] <= 1, `${k} 越界: ${f2[k]}`);
  }
  assert.ok(f2.jawOpen > f1.jawOpen, 'attack 应继续逼近目标');
  // 突停：release 120ms 缓慢回落（一帧不会归零）
  a.setSilence();
  const f3 = svc.update(16);
  assert.ok(f3.jawOpen > 0.05, `release 应缓慢回落，实际 ${f3.jawOpen.toFixed(3)}`);
  let f4 = f3;
  for (let i = 0; i < 30; i++) f4 = svc.update(16);
  assert.ok(f4.jawOpen < 0.02, `长时间静音应归零，实际 ${f4.jawOpen.toFixed(3)}`);
});

test('setTimingSource：切换为时间戳驱动，接口输出被钳制；传 null 恢复频谱驱动', () => {
  const a = new FakeAnalyser();
  a.setSilence();
  const svc = new LipSyncService(a);
  svc.setTimingSource(() => ({ aa: 1.7, ih: 0.2, ou: -1, ee: 0, oh: 0, jawOpen: NaN }));
  const f = svc.update(16);
  assert.equal(f.aa, 1, '超界输入应被钳制到 1');
  assert.equal(f.ou, 0, '负值应被钳制到 0');
  assert.equal(f.jawOpen, 0, 'NaN 应被钳制到 0');
  svc.setTimingSource(null);
  let f2: VisemeFrame = svc.update(16);
  for (let i = 0; i < 30; i++) f2 = svc.update(16); // release 收敛
  assert.deepEqual(f2, { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, jawOpen: 0 }, '恢复后静音应收敛为零');
});

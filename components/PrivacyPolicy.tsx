import React from 'react';

/**
 * 隐私政策与用户同意文案（PRD 4.1.9 / I.2）
 * 说明数据用途、保存期限、第三方 API（DeepSeek / StepFun）数据处理。
 */

interface PrivacyPolicyProps {
  onClose: () => void;
}

const PrivacyPolicy: React.FC<PrivacyPolicyProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-8">
        <h2 className="text-2xl font-bold text-slate-900 mb-6">隐私政策与数据说明</h2>

        <section className="mb-6">
          <h3 className="font-bold text-slate-800 mb-2">1. 我们收集什么</h3>
          <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
            <li>群面转写文本（你的发言与 AI 角色发言）与聚合特征（发言时长、打断次数、话语权占比等）。只有勾选设备检测页的保存同意后，才写入群证服务器。</li>
            <li>不勾选时不创建服务端会话；会话、转写与报告仅保存在当前浏览器，最多保留最近 10 条本地练习。你可在对应报告页删除。</li>
            <li><b>原始音频与视频默认不保存</b>；摄像头分析全部在浏览器本地完成，原始视频 0 字节上传。</li>
          </ul>
        </section>

        <section className="mb-6">
          <h3 className="font-bold text-slate-800 mb-2">2. 数据用途</h3>
          <p className="text-sm text-slate-600">仅用于完成本次群面互动与面后评估，不用于任何其他目的。未同意服务端保存时，本平台不会持久化该会话数据到服务器。</p>
        </section>

        <section className="mb-6">
          <h3 className="font-bold text-slate-800 mb-2">3. 第三方 API 数据处理</h3>
          <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
            <li>
              <b>DeepSeek</b>：处理 AI 角色发言与面后分析所需的文本内容（预设题目、对话历史）；练习题来自预设题库，不由 AI 生成。
            </li>
            <li>
              <b>StepFun</b>：处理语音合成（TTS）与语音识别（ASR）所需的文本/音频片段；凭证由服务端短时签发。
            </li>
            <li>使用 AI 互动或语音功能时，即使选择本地保存，会话所需文本/音频仍会发送至对应第三方 API 处理；API 密钥仅保存在服务端，前端不持有密钥。</li>
          </ul>
        </section>

        <section className="mb-6">
          <h3 className="font-bold text-slate-800 mb-2">4. 保存期限与删除</h3>
          <p className="text-sm text-slate-600">
            服务端记录仅在你明确同意后保存；你可在报告页点击「删除本次记录」<b>不可恢复地</b>删除。仅本地保存的记录可在报告页删除，也可清理浏览器站点数据；原始音视频不写入记录。
          </p>
        </section>

        <section className="mb-8">
          <h3 className="font-bold text-slate-800 mb-2">5. 形象合规</h3>
          <p className="text-sm text-slate-600">所有 AI 形象均为风格化虚拟形象，不使用任何真实名人的肖像、姓名或声音克隆。</p>
        </section>

        <button onClick={onClose} className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800">
          我已了解
        </button>
      </div>
    </div>
  );
};

export default PrivacyPolicy;

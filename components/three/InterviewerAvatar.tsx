import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { VisemeFrame } from '../../services/lipsync';

/**
 * InterviewerAvatar —— VRM 数字人面试官（M7 P3-2）
 * - @pixiv/three-vrm VRMLoaderPlugin 加载；VRM0 经 VRMUtils.rotateVRM0 修正朝向
 * - expressionManager 驱动 happy/angry/sad/relaxed；viseme 驱动 aa/ih/ou/ee/oh + jawOpen
 * - 用户发言时 lookAt 摄像头（增强「在被面试」压迫感）；空闲呼吸 + 微头部摆动（~40 行自写，不引依赖）
 * - 严禁真实名人形象（C7）：只用风格化 VRM；vrmUrl=null 回落 DiceBear SVG 平面贴片
 *
 * Props 契约（计划 §P3-2）：viseme 以「帧共享 ref」传入而非逐帧 prop（60fps 下避免 React 重渲染，行为等价）。
 */

export interface InterviewerAvatarProps {
  vrmUrl: string | null;
  /** vrmUrl=null 时的 DiceBear SVG 回落 */
  fallbackImageUrl: string;
  isSpeaking: boolean;
  /** 被调度选中（未出声） */
  active?: boolean;
  emotion?: string;
  /** 帧共享 viseme（LipSyncService 输出；见 props 契约注释） */
  viseme: { current: VisemeFrame };
  visemeProfile?: 'default' | 'wide' | 'subtle';
  /** 用户正在说（lookAt 触发） */
  userSpeaking?: boolean;
}

/** LLM emotion → VRM expression 预设映射 */
const EMOTION_MAP: Record<string, { name: string; weight: number }> = {
  positive: { name: 'happy', weight: 0.7 },
  happy: { name: 'happy', weight: 0.8 },
  relaxed: { name: 'relaxed', weight: 0.6 },
  tense: { name: 'surprised', weight: 0.5 },
  angry: { name: 'angry', weight: 0.6 },
  sad: { name: 'sad', weight: 0.6 },
  serious: { name: 'neutral', weight: 0.4 },
  neutral: { name: 'neutral', weight: 0 },
};

function VrmAvatar(props: InterviewerAvatarProps & { vrmUrl: string }) {
  const { vrmUrl, isSpeaking, emotion, viseme, visemeProfile = 'default', userSpeaking } = props;
  const gltf = useLoader(GLTFLoader, vrmUrl, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });
  const vrm = gltf.userData.vrm as VRM;
  const lookFront = useMemo(() => new THREE.Vector3(0, 1.4, 5), []);
  const bones = useRef<{ chest: THREE.Object3D | null; head: THREE.Object3D | null; chestBaseY: number; headBaseRot: { x: number; y: number } }>({
    chest: null,
    head: null,
    chestBaseY: 0,
    headBaseRot: { x: 0, y: 0 },
  });

  useEffect(() => {
    // VRM0 才需要朝向修正（VRM1 已面向 +Z）
    if (String((vrm.meta as { metaVersion?: string })?.metaVersion ?? '1') === '0') {
      VRMUtils.rotateVRM0(vrm);
    }
    if (vrm.lookAt) vrm.lookAt.autoUpdate = true;
    const chest = vrm.humanoid?.getNormalizedBoneNode('chest') ?? null;
    const head = vrm.humanoid?.getNormalizedBoneNode('head') ?? null;
    bones.current = {
      chest,
      head,
      chestBaseY: chest?.position.y ?? 0,
      headBaseRot: { x: head?.rotation.x ?? 0, y: head?.rotation.y ?? 0 },
    };
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false; // VRM 蒙皮包围盒不可靠，防止半身取景被误剔除
    });
  }, [vrm]);

  useFrame((state, dt) => {
    vrm.update(dt);
    const t = state.clock.elapsedTime;
    const mgr = vrm.expressionManager;
    const profileScale = visemeProfile === 'wide' ? 1.35 : visemeProfile === 'subtle' ? 0.6 : 1;

    if (mgr) {
      // 口型：仅在出声时应用（避免 AI 不说话时嘴巴乱动）
      const frame = viseme.current;
      const w = isSpeaking ? profileScale : 0;
      mgr.setValue('aa', Math.min(1, frame.aa * w));
      mgr.setValue('ih', Math.min(1, frame.ih * w));
      mgr.setValue('ou', Math.min(1, frame.ou * w));
      mgr.setValue('ee', Math.min(1, frame.ee * w));
      mgr.setValue('oh', Math.min(1, frame.oh * w));

      // 情绪基底（被口型覆盖的通道除外，直接写值）
      const emo = EMOTION_MAP[emotion ?? 'neutral'] ?? EMOTION_MAP.neutral;
      for (const name of ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const) {
        mgr.setValue(name, emo.name === name ? emo.weight : 0);
      }
    }

    // 空闲态：呼吸 + 微头部摆动
    const { chest, head, chestBaseY, headBaseRot } = bones.current;
    if (chest) chest.position.y = chestBaseY + Math.sin(t * 1.6) * 0.004;
    if (head) {
      head.rotation.y = headBaseRot.y + Math.sin(t * 0.45) * 0.05;
      head.rotation.x = headBaseRot.x + Math.sin(t * 0.7) * 0.02;
    }

    // lookAt：用户发言时看向摄像头（压迫感）；否则看向正前
    if (vrm.lookAt) {
      vrm.lookAt.target = userSpeaking ? state.camera.position : lookFront;
    }
  });

  // 半身取景：模型原点在脚底，镜头参数由 ImmersiveScene 控制
  return <primitive object={vrm.scene} />;
}

/** DiceBear SVG 平面贴片回落（vrm_url=null 的老角色卡不炸） */
function SvgAvatar({ fallbackImageUrl }: { fallbackImageUrl: string }) {
  const tex = useLoader(THREE.TextureLoader, fallbackImageUrl, (loader) => {
    loader.setCrossOrigin('anonymous');
  });
  return (
    <Billboard position={[0, 1.35, 0]}>
      <mesh>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial map={tex} transparent toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </Billboard>
  );
}

/** 说话者身后扫光（BorderBeam 式，参考 Jakubantalik/Libraries.dev 的视觉语义） */
function SpeakerGlow({ color = '#5b6cff' }: { color?: string }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ring.current;
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.35 + Math.sin(state.clock.elapsedTime * 3) * 0.15;
    m.rotation.z = state.clock.elapsedTime * 0.8;
  });
  return (
    <mesh ref={ring} position={[0, 1.35, -0.35]}>
      <ringGeometry args={[0.62, 0.72, 48, 1, 0, Math.PI * 1.5]} />
      <meshBasicMaterial color={color} transparent opacity={0.4} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

const InterviewerAvatar: React.FC<InterviewerAvatarProps> = (props) => {
  return (
    <group>
      {props.vrmUrl ? <VrmAvatar {...props} vrmUrl={props.vrmUrl} /> : <SvgAvatar fallbackImageUrl={props.fallbackImageUrl} />}
      {props.isSpeaking && <SpeakerGlow />}
    </group>
  );
};

export default InterviewerAvatar;

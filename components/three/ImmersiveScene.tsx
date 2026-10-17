import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { ContactShadows, PresentationControls } from '@react-three/drei';
import * as THREE from 'three';
import type { RoleCard } from '../../types';
import type { SessionSnapshot } from '../../src/session/sessionStore';
import { findAvatarPreset } from '../../data/avatars.ts';
import { LipSyncService, type VisemeFrame } from '../../services/lipsync';
import InterviewerAvatar from './InterviewerAvatar';

/**
 * ImmersiveScene —— R3F 场景内容（M7 P3-1）
 * - 全程序化资源（灯光/几何体/接触阴影）：无 HDR/外部资产，离线可跑（CN 网络安全）
 * - AudioReactiveLights：AnalyserNode RMS → 点光源强度 + 背板自发光
 * - VisemeDriver：LipSyncService 帧驱动（频谱 → viseme，D3）
 */

export interface SceneShared {
  analyser: { current: AnalyserNode | null };
  viseme: { current: VisemeFrame };
}

interface Props {
  roles: RoleCard[];
  snapshot: SessionSnapshot;
  shared: SceneShared;
}

/** 角色最近一条发言的 emotion（驱动 VRM 表情） */
function emotionOf(roles: RoleCard[], snapshot: SessionSnapshot, cardId: string): string | undefined {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const m = snapshot.messages[i];
    if (m.senderId === cardId) return m.emotion;
  }
  return undefined;
}

/** 口型驱动器：每帧从 TTS 分析器读频谱 → VisemeFrame（共享 ref，不进 React 状态） */
function VisemeDriver({ shared }: { shared: SceneShared }) {
  const svcRef = useRef<LipSyncService | null>(null);
  useFrame((_, dt) => {
    const analyser = shared.analyser.current;
    if (!analyser) return;
    if (!svcRef.current) svcRef.current = new LipSyncService(analyser);
    shared.viseme.current = svcRef.current.update(dt * 1000);
  });
  return null;
}

/** 音频律动灯：TTS RMS → 主光强度 / 背板自发光 */
function AudioReactiveLights({ shared }: { shared: SceneShared }) {
  const keyLight = useRef<THREE.PointLight>(null);
  const rimLight = useRef<THREE.PointLight>(null);
  const strip = useRef<THREE.MeshStandardMaterial>(null);
  const buffer = useMemo(() => new Uint8Array(1024), []);
  useFrame(() => {
    let rms = 0;
    const analyser = shared.analyser.current;
    if (analyser) {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sum += v * v;
      }
      rms = Math.sqrt(sum / buffer.length);
    }
    const energy = Math.min(1, rms * 5);
    if (keyLight.current) keyLight.current.intensity = 1.1 + energy * 1.6;
    if (rimLight.current) rimLight.current.intensity = 0.7 + energy * 2.2;
    if (strip.current) strip.current.emissiveIntensity = 0.6 + energy * 2.4;
  });
  return (
    <>
      <pointLight ref={keyLight} position={[2.6, 3.2, 2.4]} intensity={1.1} color="#dfe8ff" />
      <pointLight ref={rimLight} position={[-2.8, 2.8, -1.2]} intensity={0.7} color="#5b6cff" />
      {/* 背板自发光条（AudioReactiveLights 的另一端点） */}
      <mesh position={[0, 2.2, -1.95]}>
        <boxGeometry args={[5.4, 0.06, 0.06]} />
        <meshStandardMaterial ref={strip} color="#1b2140" emissive="#5b6cff" emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
    </>
  );
}

/** 面试间壳体：地板 / 背板 / 长桌（程序化几何，三点击补光配合） */
function RoomShell() {
  return (
    <group>
      {/* 地板 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[16, 16]} />
        <meshStandardMaterial color="#101528" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* 背板 */}
      <mesh position={[0, 1.6, -2]}>
        <boxGeometry args={[5.6, 3.4, 0.12]} />
        <meshStandardMaterial color="#141a33" roughness={0.85} />
      </mesh>
      {/* 长桌（面试官侧） */}
      <mesh position={[0, 0.72, -0.55]}>
        <boxGeometry args={[4.4, 0.08, 0.9]} />
        <meshStandardMaterial color="#1d2440" roughness={0.6} metalness={0.25} />
      </mesh>
      <mesh position={[0, 0.36, -0.55]}>
        <boxGeometry args={[4.0, 0.68, 0.7]} />
        <meshStandardMaterial color="#151a30" roughness={0.8} />
      </mesh>
    </group>
  );
}

const ImmersiveScene: React.FC<Props> = ({ roles, snapshot, shared }) => {
  // 均匀排布在桌后：3 人 → x=-1.2/0/1.2；更多角色按比例展开
  const spacing = Math.min(1.2, 3.2 / Math.max(1, roles.length));
  const startX = (-spacing * (roles.length - 1)) / 2;
  return (
    <>
      <color attach="background" args={['#0b1020']} />
      <fog attach="fog" args={['#0b1020', 7, 16]} />
      <ambientLight intensity={0.4} />
      <spotLight position={[0, 4.2, 2.2]} angle={0.65} penumbra={0.7} intensity={0.55} color="#cdd8ff" />
      <AudioReactiveLights shared={shared} />
      <VisemeDriver shared={shared} />
      <RoomShell />

      <PresentationControls
        global
        cursor
        snap
        speed={1.2}
        zoom={1}
        rotation={[0, 0, 0]}
        polar={[-0.08, 0.12]}
        azimuth={[-0.35, 0.35]}
      >
        {roles.map((card, i) => {
          const preset = findAvatarPreset(card.avatar.preset_id);
          return (
            <group key={card.id} position={[startX + i * spacing, 0, -0.55]}>
              <InterviewerAvatar
                vrmUrl={preset?.vrm_url ?? null}
                fallbackImageUrl={preset?.asset_url ?? ''}
                isSpeaking={snapshot.speakingCharId === card.id}
                active={snapshot.activeCharId === card.id}
                emotion={emotionOf(roles, snapshot, card.id)}
                viseme={shared.viseme}
                visemeProfile={preset?.viseme_profile ?? 'default'}
                userSpeaking={snapshot.userSpeaking}
              />
            </group>
          );
        })}
      </PresentationControls>

      <ContactShadows position={[0, 0.01, -0.3]} opacity={0.55} scale={9} blur={2.4} far={3.2} />
    </>
  );
};

export default ImmersiveScene;

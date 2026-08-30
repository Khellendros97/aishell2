/**
 * 总装:场景一(初始化配置 0–575)+ 场景二(AI 助手演示 570–1240)+ 全局字幕/暗角/总淡出。
 * 字幕时间全局坐标,间隔 ≥16 帧避免进出场叠影。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { AiDemo } from './AiDemo';
import { Caption } from './components/Caption';
import { FeatureCard } from './components/FeatureCard';
import { InitSetup } from './InitSetup';

const CAPTIONS = [
  { from: 4, to: 66, text: '首次启动 AIShell，先完成系统初始化' },
  { from: 84, to: 248, text: '第一步：选择 Workspace 目录，项目将默认创建在这里' },
  { from: 266, to: 334, text: '路径选择完成，点击「保存」使配置生效' },
  { from: 352, to: 392, text: '出现「设置已保存」提示，配置完成' },
  { from: 410, to: 530, text: '接下来登录云平台，免配置使用 AI' },
  { from: 590, to: 665, text: '登录完成，打开工作台体验 AI 助手' },
];

/* 场景二特性注记(推镜后左侧留白区;与问答节拍对齐) */
const FEATURES = [
  { from: 700, to: 912, kicker: '特性 01', title: '知识库查询', desc: '发消息时自动检索企业知识库，结合命中内容作答并注明来源' },
  { from: 975, to: 1135, kicker: '特性 02', title: '联网搜索', desc: '遇到时效性问题自动联网检索，回答引用关键来源' },
];

export const Video: React.FC = () => {
  const frame = useCurrentFrame();
  const masterFade = interpolate(frame, [1210, 1240], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#0a0b0e' }}>
      {frame < 575 && <InitSetup />}
      {frame >= 570 && <AiDemo />}

      {/* 暗角 */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.26) 100%)',
          pointerEvents: 'none',
        }}
      />
      {CAPTIONS.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      {FEATURES.map((f) => (
        <FeatureCard key={f.from} from={f.from} to={f.to} kicker={f.kicker} title={f.title} desc={f.desc} />
      ))}

      {/* 结尾淡出 */}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

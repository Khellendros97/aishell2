/**
 * 标签页类型注册表(React 迁移新增):type → 标签组件。
 * 对照旧版 core.ts 的 registerRenderer(fn(container, tab))副作用注册;
 * React 版为静态映射,新增标签类型往这里接线。
 * keep-alive 契约:所有 pane 常驻挂载、仅切换显隐(终端/编辑器实例不随标签切换销毁),
 * 关闭标签才卸载(触发组件 useEffect 清理 → term_close 等后端回收)。
 */
import type { ComponentType } from 'react';
import type { TabProps } from '../../../stores/workbench';
import { TerminalTab } from './TerminalTab';
import { EditorTab } from './EditorTab';
import { SftpTab } from './SftpTab';
import { StagingTab } from './StagingTab';
import { DiffTab } from './DiffTab';
import BrowserTab from './BrowserTab';
import SkillHubTab from './SkillHubTab';
import { TraceTab } from './TraceTab';
import { NoteTab } from './NoteTab';

export const TAB_TYPES: Record<string, ComponentType<TabProps>> = {
  terminal: TerminalTab,
  editor: EditorTab,
  sftp: SftpTab,
  'remote-staging': StagingTab,
  'staging-diff': DiffTab,
  browser: BrowserTab,
  'skill-hub': SkillHubTab,
  trace: TraceTab,
  note: NoteTab,
};

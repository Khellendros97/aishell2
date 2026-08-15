/**
 * 终端标签页(React 迁移,整文件替换占位)。
 * 对照 legacy/pages/workbench/terminal.ts 的 renderTerminal:挂载 = 终端会话开始,
 * 卸载 = 会话销毁;keep-alive 契约见 stores/workbench.ts(panes 常驻挂载,active 只切显隐),
 * 会话/订阅/后端回收的挂载卸载逻辑在 useTerminal 内完成,本组件只负责:
 * - 一次性渲染与 legacy 逐条对齐的 DOM 结构(term-root/term-info/term-xterm/term-drawer…,
 *   共享 CSS 已在 src/pages/workbench/workbench.css,由外壳 import,此处不重复引入);
 * - 把静态元素的 ref 交给 TermSession(信息栏/抽屉/按钮的后续内容更新全部走命令式
 *   DOM,与 legacy 行为一致;React 不再渲染这些可变内容,避免 vdom 覆盖会话写入)。
 * 后端接口点:见 useTerminal.ts(term_create/term_input/term_resize/term_close、
 * term_record_start/term_record_stop,事件 term:data:<id> / term:exit:<id>)。
 * 导出签名契约:export function TerminalTab({ tab, active }: TabProps),TabProps import 自
 * '../../../stores/workbench'(registry.ts 接线,不得变更)。
 */
import { useRef } from 'react';
import type { TabProps } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import { useTerminal, type TermElementRefs } from './useTerminal';

export function TerminalTab({ tab, active }: TabProps): JSX.Element {
  const els: TermElementRefs = {
    host: useRef<HTMLDivElement>(null),
    infoCmd: useRef<HTMLSpanElement>(null),
    drawer: useRef<HTMLDivElement>(null),
    drawerBody: useRef<HTMLDivElement>(null),
    drawerToggle: useRef<HTMLButtonElement>(null),
    drawerClose: useRef<HTMLButtonElement>(null),
    clearBtn: useRef<HTMLButtonElement>(null),
    addChatBtn: useRef<HTMLButtonElement>(null),
    pinBtn: useRef<HTMLButtonElement>(null),
    recBtn: useRef<HTMLButtonElement>(null),
  };
  /* 挂载=会话开始,卸载=销毁,active 变化=聚焦/fit;会话初始化前的初始按钮态与
     legacy 构造器一致(清空按钮禁用、其余启用、抽屉可见、信息栏命令为空)。 */
  useTerminal(tab, active, els);

  return (
    <div className="term-root">
      <div className="term-info">
        <span>最后命令:</span>
        <span ref={els.infoCmd} className="term-info-cmd"></span>
        <span className="term-info-spacer"></span>
        <button ref={els.drawerToggle} className="btn small term-toggle-drawer" title="历史命令"><Icon name="history" /> 历史命令</button>
        <button ref={els.pinBtn} className="btn small term-pin"><Icon name="star" /> 命令收藏</button>
        <button ref={els.addChatBtn} className="btn small term-addchat"><Icon name="chatPlus" /> 添加到chat</button>
        <button ref={els.recBtn} className="btn small term-rec" title="录制终端输出到日志文件"><Icon name="circle" /> 录制</button>
      </div>
      <div className="term-main">
        <div ref={els.host} className="term-xterm"></div>
        <div ref={els.drawer} className="term-drawer">
          <div className="term-drawer-head">
            <span>历史命令</span>
            <span className="term-drawer-actions">
              <button ref={els.clearBtn} className="icon-btn term-drawer-clear" title="清空历史命令" disabled><Icon name="trash" /></button>
              <button ref={els.drawerClose} className="btn small ghost term-drawer-close">收起</button>
            </span>
          </div>
          <div ref={els.drawerBody} className="term-drawer-body"></div>
        </div>
      </div>
    </div>
  );
}

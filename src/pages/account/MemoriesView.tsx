/**
 * 记忆宫殿子页（React 版）—— 云账号三页导航的第三页。
 * 对照旧实现 src/pages/account.ts 的 guardCloud / loadMemories / searchMemories / renderMemories /
 * mountMemoriesToolbar / onMemoriesClick / memoryCardFromDom：
 * 语义检索搜索框（300ms 防抖 + 回车立即）、作用域 tabs（全部/共享/我的个人，切换保留当前搜索词）、
 * 卡片列表（分类/来源/作用域徽标 + 相关度 + 提升/历史/编辑/删除操作，提升与删除走 confirmDialog）。
 * 与后端的接口点（见 src/api.ts）：memoriesList / memorySearch / memoryPromote / memoryDelete；
 * 新增/编辑走 MemoryModal（memoryCreate / memoryUpdate），历史走 MemoryHistoryModal（memoryHistory）。
 * 实现差异说明：
 * - 卡片数据直接来自 API 返回对象（旧实现从渲染 DOM 反解 memoryCardFromDom，脆弱且丢字段），已修复；
 * - 搜索词为本组件内部状态：切换子页回来输入框为空（同旧实现重挂载行为），
 *   且保存/删除/提升后的刷新以当前状态为准，不再出现旧实现的「空输入框却按旧词检索」；
 * - 检索失败清空输入框（旧实现只清内部变量、输入框残留旧词）。
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { CloudStatus, MemoryCard, MemoryScope } from '../../types';
import { memoriesList, memoryDelete, memoryPromote, memorySearch } from '../../api';
import { confirmDialog, toast } from '../../ui';
import { Icon } from '../../shared/Icon';
import { MemoryModal } from './MemoryModal';
import { MemoryHistoryModal } from './MemoryHistoryModal';

/** 列表卡片 = 全量字段；检索命中在卡片字段基础上带 _score（旧实现 renderMemories 同样合并） */
type CardItem = MemoryCard & { _score?: number };

const SCOPE_TABS: Array<{ value: MemoryScope; label: string; title: string }> = [
  { value: 'all', label: '全部', title: '共享卡片 + 我的个人卡片' },
  { value: 'shared', label: '共享', title: '团队全员可见的共享卡片' },
  { value: 'personal', label: '我的个人', title: '仅本人可见的个人卡片' },
];

/** 记忆搜索防抖毫秒数（同旧实现 300） */
const SEARCH_DEBOUNCE_MS = 300;

interface MemoriesViewProps {
  status: CloudStatus | null;
  /** 列表/检索作用域（由父组件 Account 持有，跨子页切换保留，同旧实现 memScope） */
  scope: MemoryScope;
  onScopeChange: (s: MemoryScope) => void;
  onGoLogin: () => void;
}

/** 单张记忆卡片（同旧实现 renderMemories 的卡片模板；操作用元素级 onClick 替代旧版 DOM 事件委托） */
function MemCardItem({ card, selfId, onPromote, onHistory, onEdit, onDelete }: {
  card: CardItem;
  selfId: number | null;
  onPromote: (id: string) => void;
  onHistory: (card: MemoryCard) => void;
  onEdit: (card: MemoryCard) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const mine = selfId != null && card.creatorId === selfId;
  const personal = card.scope === 'personal';
  const tags = (card.tags ?? []).filter((t) => t.trim());
  return (
    <div className="mem-card" data-id={card.id}>
      <div className="mem-card-head">
        {card.category?.trim()
          ? <span className="mem-cat">{card.category}</span>
          : <span className="mem-cat muted">未分类</span>}
        {card.source === 'auto'
          ? <span className="mem-source mem-source-auto" title="对话流量 AI 自动沉淀">自动</span>
          : <span className="mem-source" title="用户主动提交，原文保存">手动</span>}
        {personal
          ? <span className="mem-scope mem-scope-personal" title="仅本人可见">个人</span>
          : <span className="mem-scope" title="团队全员可见">共享</span>}
        <span className="mem-time" title="创建 / 最后更新">{card.createdAt}</span>
      </div>
      <div className="mem-content">{card.content}</div>
      {tags.length > 0 ? (
        <div className="mem-tags">{tags.map((t) => <span className="mem-tag" key={t}>{t}</span>)}</div>
      ) : null}
      <div className="mem-card-foot">
        <span className="mem-creator">{card.creatorName || '未知'}{card.dept ? ` · ${card.dept}` : ''}</span>
        {card._score != null
          ? <span className="mem-score" title="相关度（值越小越相关）">相关度 {card._score.toFixed(3)}</span>
          : null}
        <span className="mem-actions">
          {mine && personal ? (
            <button className="icon-btn" title="提升为共享" aria-label="提升为共享"
                    onClick={() => onPromote(card.id)}><Icon name="upload" /></button>
          ) : null}
          <button className="icon-btn" title="变更历史" aria-label="变更历史"
                  onClick={() => onHistory(card)}><Icon name="history" /></button>
          {mine ? (
            <>
              <button className="icon-btn" title="编辑" aria-label="编辑"
                      onClick={() => onEdit(card)}><Icon name="pencil" /></button>
              <button className="icon-btn" title="删除" aria-label="删除"
                      onClick={() => onDelete(card.id)}><Icon name="trash" /></button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function MemoriesView({ status, scope, onScopeChange, onGoLogin }: MemoriesViewProps): JSX.Element {
  /** 搜索词（仅本组件持有：切换子页重挂载后输入框为空，与旧实现一致） */
  const [query, setQuery] = useState('');
  /** 当前生效的检索词：null = 列表模式；非空 = 检索结果（渲染提示与空态文案用） */
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [cards, setCards] = useState<CardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 新增/编辑弹窗（null = 关闭） */
  const [modal, setModal] = useState<{ mode: 'new' } | { mode: 'edit'; card: MemoryCard } | null>(null);
  /** 变更历史弹窗目标卡（null = 关闭） */
  const [historyCard, setHistoryCard] = useState<MemoryCard | null>(null);

  /** 异步竞态序号（同旧实现 memoriesSeq）：切换作用域/防抖触发后丢弃迟到响应 */
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载清理防抖定时器
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  /** 全量列表（同旧实现 loadMemories；守卫已在渲染层拦截，此处再兜底） */
  const loadMemories = async (): Promise<void> => {
    if (!status?.serverUrl || !status.loggedIn) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await memoriesList(scope);
      if (seq !== seqRef.current) return;
      setCards(list);
      setActiveQuery(null);
      setLoading(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(String(e));
      setLoading(false);
    }
  };

  /** 语义检索（同旧实现 searchMemories：topK 20；失败 toast 后回退全量列表） */
  const searchMemories = async (q: string): Promise<void> => {
    if (!status?.serverUrl || !status.loggedIn) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const hits = await memorySearch(q, 20, scope);
      if (seq !== seqRef.current) return;
      setCards(hits.map((h) => ({ ...h, _score: h.score })));
      setActiveQuery(q);
      setLoading(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      toast(`记忆检索失败: ${String(e)}`, 'error');
      setQuery(''); // 旧实现只清内部变量、输入框残留旧词；这里一并清空
      void loadMemories();
    }
  };

  /** 有词走检索、无词走列表（同旧实现 run） */
  const run = (q: string): void => {
    setQuery(q);
    const t = q.trim();
    if (t) void searchMemories(t);
    else void loadMemories();
  };

  // 挂载 + 作用域切换：保留当前搜索词重跑（同旧实现 mountMemoriesToolbar 结尾 load + 作用域 tab 点击 run）
  useEffect(() => { void run(query); /* eslint 语义同旧版：scope 变化重跑当前词 */ }, [scope]);

  /** 保存/删除/提升后的刷新（以当前生效词为准，同旧实现 `memQuery ? search : load`） */
  const refresh = (): void => { void run(query); };

  const onSearchInput = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = e.currentTarget.value;
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { debounceRef.current = null; run(v); }, SEARCH_DEBOUNCE_MS);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      run(e.currentTarget.value);
    }
  };

  const onPromote = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: '提升为共享',
      message: '确定将这条个人记忆提升为团队共享吗？\n提升后全员可见，原个人卡片将被共享卡片替换（内容不变），操作写入审计日志。',
      okText: '提升',
    });
    if (!ok) return;
    try {
      const newId = await memoryPromote(id);
      toast(`已提升为共享（新卡片 ${newId.slice(0, 8)}…）`, 'success');
      refresh();
    } catch (err) {
      toast(`提升失败: ${String(err)}`, 'error');
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    const ok = await confirmDialog({
      title: '删除记忆卡片',
      message: '确定删除这条记忆吗？删除后全员不可见，变更历史一并清除，且不可恢复。',
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    try {
      await memoryDelete(id);
      toast('记忆已删除', 'success');
      refresh();
    } catch (err) {
      toast(`删除失败: ${String(err)}`, 'error');
    }
  };

  // 守卫（同旧实现 guardCloud 渲染形态）：未接入云服务
  if (!status?.serverUrl) {
    return <div className="cloud-empty"><div>当前构建未接入云服务，该功能不可用。</div></div>;
  }
  // 守卫：未登录
  if (!status.loggedIn) {
    return (
      <div className="cloud-empty">
        <div>登录公司账号后即可使用该功能。</div>
        <button className="btn primary small" onClick={onGoLogin}>去登录</button>
      </div>
    );
  }

  const selfId = status?.user?.id ?? null;
  return (
    <>
      <div className="account-toolbar" id="memories-toolbar">
        <div className="mem-search-wrap">
          <Icon name="search" />
          <input id="mem-search" className="input" type="text" spellCheck={false} value={query}
                 placeholder="语义检索记忆，回车搜索，清空回到列表…"
                 onChange={onSearchInput} onKeyDown={onSearchKeyDown} />
        </div>
        <button className="btn primary small" onClick={() => setModal({ mode: 'new' })}>
          <Icon name="plus" /> 新增记忆
        </button>
      </div>
      <div className="mem-scope-tabs" id="mem-scope-tabs">
        {SCOPE_TABS.map((t) => (
          <button key={t.value} className={`mem-scope-tab${scope === t.value ? ' active' : ''}`}
                  title={t.title} onClick={() => onScopeChange(t.value)}>{t.label}</button>
        ))}
      </div>
      <div id="memories-content">
        {/* 检索提示行常驻（同旧实现：无检索词时也渲染空的 .mem-result-hint 占位） */}
        <div className="mem-result-hint">
          {activeQuery ? `「${activeQuery}」的检索结果（${cards.length} 条）` : ''}
        </div>
        {loading ? (
          <div className="loading-row"><Icon name="loader" /> 加载记忆卡片…</div>
        ) : error ? (
          <div className="cloud-empty">
            <div className="err-text">加载记忆卡片失败：{error}</div>
            <button className="btn small" onClick={() => void loadMemories()}>重试</button>
          </div>
        ) : cards.length === 0 ? (
          <div className="cloud-empty">
            {activeQuery ? '没有检索到相关记忆' : '暂无记忆卡片，点击「新增记忆」提交第一条团队记忆'}
          </div>
        ) : (
          <div className="mem-list">
            {cards.map((c) => (
              <MemCardItem key={c.id} card={c} selfId={selfId}
                           onPromote={(id) => void onPromote(id)}
                           onHistory={(card) => setHistoryCard(card)}
                           onEdit={(card) => setModal({ mode: 'edit', card })}
                           onDelete={(id) => void onDelete(id)} />
            ))}
          </div>
        )}
      </div>
      {modal ? (
        <MemoryModal
          card={modal.mode === 'edit' ? modal.card : null}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      ) : null}
      {historyCard ? <MemoryHistoryModal card={historyCard} onClose={() => setHistoryCard(null)} /> : null}
    </>
  );
}

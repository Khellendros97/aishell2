/**
 * 记忆卡片新增/编辑弹窗（React 版）。
 * 对照旧实现 src/pages/account.ts 的 openMemoryModal：内容/分类必填（服务端权威校验）、
 * 新增可选可见范围（团队共享/仅自己可见）、编辑带「纠正说明」写入变更历史、错误内联展示。
 * 与后端的接口点（见 src/api.ts）：memoryCreate / memoryUpdate；保存成功后由父级回调刷新列表。
 * 弹窗骨架复用 MaskModal（.modal-mask .open 淡入淡出语义同旧实现）。
 */
import { useState } from 'react';
import type { MemoryCard, MemoryScope } from '../../types';
import { memoryCreate, memoryUpdate } from '../../api';
import { toast } from '../../ui';
import { MaskModal } from './MaskModal';

/** 记忆卡片建议固定分类（记忆卡片 API 文档 §2.1，同旧实现 MEMORY_CATEGORIES） */
const MEMORY_CATEGORIES = ['编码规范', '排障经验', '提示词技巧', '工具配置', '业务流程', '其他', '个人记忆'];

interface MemoryModalProps {
  /** null = 新增；否则编辑该卡片 */
  card: MemoryCard | null;
  onClose: () => void;
  /** 保存成功后刷新列表（父级按当前搜索词/列表态重载） */
  onSaved: () => void;
}

export function MemoryModal({ card, onClose, onSaved }: MemoryModalProps): JSX.Element {
  const isNew = !card;
  const [content, setContent] = useState(card?.content ?? '');
  /** 分类：新增默认第一项（同旧实现无 selected 时浏览器默认选中首项）；编辑取卡片原值 */
  const [category, setCategory] = useState(card?.category || MEMORY_CATEGORIES[0]);
  const [tags, setTags] = useState((card?.tags ?? []).join(', '));
  const [scope, setScope] = useState<'shared' | 'personal'>(card?.scope === 'personal' ? 'personal' : 'shared');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  /** 编辑卡片分类不在固定列表时保留原值作为额外选项（旧实现会静默丢成首项，属修复） */
  const catOptions = card?.category && !MEMORY_CATEGORIES.includes(card.category)
    ? [card.category, ...MEMORY_CATEGORIES]
    : MEMORY_CATEGORIES;

  const save = async (): Promise<void> => {
    const c = content.trim();
    const tagList = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    if (!c) { setErr('记忆内容不能为空'); return; }
    if (!category) { setErr('请选择分类'); return; }
    setErr(null);
    try {
      if (isNew) {
        await memoryCreate(c, category, tagList, scope as MemoryScope);
        toast('记忆已提交', 'success');
      } else {
        await memoryUpdate(card.id, c, category, tagList, note.trim());
        toast('记忆已更新', 'success');
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <MaskModal
      width={520}
      onClose={onClose}
      head={<h3>{isNew ? '新增记忆' : '编辑记忆'}</h3>}
      body={
        <>
          <div className="field">
            <label>内容<span className="req">*</span></label>
            <textarea id="mem-content" className="input" rows={4} spellCheck={false}
                      placeholder="例如：生产发布前必须冻结主干分支" value={content}
                      onChange={(e) => setContent(e.currentTarget.value)} />
            <div className="hint">主动提交的内容原文保存，不被 AI 改写；提交后全员立即可见</div>
          </div>
          <div className="field">
            <label>分类<span className="req">*</span></label>
            <select id="mem-category" className="select" value={category}
                    onChange={(e) => setCategory(e.currentTarget.value)}>
              {catOptions.map((c) => <option value={c} key={c}>{c}</option>)}
            </select>
          </div>
          {isNew ? (
            <div className="field">
              <label>可见范围</label>
              <div className="mem-scope-radio">
                <label className={`mode-option${scope === 'shared' ? ' active' : ''}`}>
                  <input type="radio" name="mem-scope" value="shared" checked={scope === 'shared'}
                         onChange={() => setScope('shared')} /> 团队共享（全员可见）
                </label>
                <label className={`mode-option${scope === 'personal' ? ' active' : ''}`}>
                  <input type="radio" name="mem-scope" value="personal" checked={scope === 'personal'}
                         onChange={() => setScope('personal')}
                         title="仅本人可见；之后可在列表中提升为共享" /> 仅自己可见
                </label>
              </div>
            </div>
          ) : null}
          <div className="field">
            <label>标签（逗号分隔，可选）</label>
            <input id="mem-tags" className="input" type="text" spellCheck={false} value={tags}
                   onChange={(e) => setTags(e.currentTarget.value)} placeholder="例如：发布, 分支" />
          </div>
          {!isNew ? (
            <div className="field">
              <label>纠正说明（可选，写入变更历史留痕）</label>
              <input id="mem-note" className="input" type="text" spellCheck={false} value={note}
                     onChange={(e) => setNote(e.currentTarget.value)} placeholder="例如：补充 hotfix 例外说明" />
            </div>
          ) : null}
          <div id="mem-form-err" className="form-error" hidden={!err}>{err}</div>
        </>
      }
      foot={
        <>
          <button className="btn small" onClick={onClose}>取消</button>
          <button className="btn primary small" onClick={() => void save()}>保存</button>
        </>
      }
    />
  );
}

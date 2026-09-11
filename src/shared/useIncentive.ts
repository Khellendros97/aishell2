/**
 * 激励计划能力门控（激励计划 API 文档「能力开关」）。
 * capabilities.incentive 为 false 时须隐藏全部激励入口（发布工单日志、skill 上传登记、账号页激励页），
 * 否则接口返回 403 INCENTIVE_NOT_ENABLED。
 *
 * 实现为模块级单例：初始一次 cloud_status + 一条 cloud:changed 订阅，多个组件（含 keep-alive 常驻的
 * 多个笔记标签页）共用同一份值，避免每个实例各自重复请求与订阅。
 */
import { useEffect, useState } from 'react';
import { cloudStatus, onCloudChanged } from '../api';
import type { CloudStatus } from '../types';

function capabilityOn(s: CloudStatus): boolean {
  return !!s.serverUrl && s.loggedIn && s.capabilities?.incentive === true;
}

/** 当前能力值（模块级缓存） */
let cached = false;
/** 是否已发起初始化（cloud_status 拉取 + cloud:changed 订阅，只做一次） */
let initStarted = false;
/** React 订阅者（各组件 setState） */
const listeners = new Set<(v: boolean) => void>();

function publish(v: boolean): void {
  cached = v;
  listeners.forEach((fn) => fn(v));
}

function ensureInit(): void {
  if (initStarted) return;
  initStarted = true;
  void cloudStatus()
    .then((s) => publish(capabilityOn(s)))
    .catch(() => publish(false));
  // 登录/登出/能力刷新（重启或重登后 capabilities 变化）经 cloud:changed 同步
  void onCloudChanged((s) => publish(capabilityOn(s))).catch(() => {
    /* 订阅失败：保持本次拉取的值，下次挂载重试 */
  });
}

/** 订阅激励计划能力开关；多个组件共用同一份模块级值。 */
export function useIncentiveEnabled(): boolean {
  const [value, setValue] = useState(cached);
  useEffect(() => {
    ensureInit();
    listeners.add(setValue);
    setValue(cached); // 补齐挂载前可能已发生的变更
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

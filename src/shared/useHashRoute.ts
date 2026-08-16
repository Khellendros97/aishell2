/**
 * hash 路由 React 钩子(React 迁移新增):包装 src/router.ts 的 parseHash/onRoute。
 * 语义同旧版 main.ts 的 onRoute(() => render()):hash 变化触发重渲染,
 * 三条路由 '#/welcome' | '#/settings' | '#/workbench?project=<id>' 的解析规则不变。
 */
import { useEffect, useState } from 'react';
import { parseHash, type ParsedRoute } from '../router';

export function useHashRoute(): ParsedRoute {
  const [route, setRoute] = useState<ParsedRoute>(parseHash);
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

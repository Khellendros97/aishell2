/** 极简 hash 路由：'#/welcome' | '#/settings' | '#/workbench?project=<id>'
 *  | '#/ai-window?project=<id>&session=<sid>&host=<workbench|welcome>'（AI 分离窗口，
 *  仅 label = ai-detach 的独立窗口使用，hash 由后端 ai_window.rs initialization_script 注入） */
export interface ParsedRoute {
  name: string;
  params: URLSearchParams;
}

export function parseHash(): ParsedRoute {
  const h = location.hash || '#/welcome';
  const [path, qs] = h.slice(1).split('?');
  return { name: path || '/welcome', params: new URLSearchParams(qs || '') };
}

export function navigate(hash: string): void {
  location.hash = hash;
}

export function onRoute(cb: () => void): void {
  window.addEventListener('hashchange', cb);
}

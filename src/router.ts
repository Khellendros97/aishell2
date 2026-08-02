/** 极简 hash 路由：'#/welcome' | '#/settings' | '#/workbench?project=<id>' */
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

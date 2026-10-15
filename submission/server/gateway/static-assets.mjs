// Serves the browser client: GET / → index.html, GET /client/<path>.(mjs|css).
// Paths are whitelisted by pattern, so nothing outside the client folder is reachable.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONTENT_TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css' };
const SAFE_PATH = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.(?:mjs|css)$/;

export function createStaticAssets(clientDir) {
  // Returns the file to serve for a URL path, or null when it is not an asset route.
  const resolve = pathname => {
    if (pathname === '/') return 'index.html';
    if (!pathname.startsWith('/client/')) return null;
    const relative = pathname.slice('/client/'.length);
    return SAFE_PATH.test(relative) ? relative : null;
  };

  async function read(relative) {
    try {
      const bytes = await readFile(join(clientDir, relative));
      const type = CONTENT_TYPES[relative.slice(relative.lastIndexOf('.'))];
      return { bytes, type: `${type}; charset=utf-8` };
    } catch {
      return null;
    }
  }

  return { resolve, read };
}

// Serves the app's own files over a privileged custom scheme (app://local/...) instead of file://,
// so ES modules, fetch() and web fonts behave as they would on a normal https origin.
import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEME = 'app';
export const HOST = 'local';
export const APP_ROOT = path.resolve(import.meta.dirname, '..');

export const appUrl = (relativePath) => `${SCHEME}://${HOST}/${relativePath.replace(/^\/+/, '')}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** Must be called before the app's 'ready' event. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/** Resolves `pathname` inside `root`, or returns null if it would escape it. */
export function resolveInside(root, pathname) {
  const filePath = path.resolve(root, '.' + decodeURIComponent(pathname));
  return filePath.startsWith(root + path.sep) ? filePath : null;
}

/** Content type for a file; extension-less files (e.g. YouTube's saved stylesheets) follow the request. */
export function contentType(filePath, request) {
  const accept = request?.headers.get('accept') ?? '';
  return MIME[path.extname(filePath).toLowerCase()] ?? (accept.startsWith('text/css') ? MIME['.css'] : null);
}

/** A Response with the file's contents (404 if it can't be read). */
export async function fileResponse(filePath, request) {
  // net.fetch rejects (rather than resolving a 404) when the file is missing.
  const response = await net.fetch(pathToFileURL(filePath).toString()).catch(() => null);
  if (!response?.ok) return new Response('Not found', { status: 404 });
  const type = contentType(filePath, request);
  return type ? new Response(response.body, { headers: { 'content-type': type } }) : response;
}

/**
 * Handles app:// requests for `session`. app://local/<path> maps to APP_ROOT/<path>; `hosts` can map
 * further hosts, as { 'some.host': (pathname) => absoluteFilePath | null }.
 */
export function handleAppScheme(session, { hosts = {} } = {}) {
  const resolvers = { [HOST]: (pathname) => resolveInside(APP_ROOT, pathname), ...hosts };

  session.protocol.handle(SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    const filePath = resolvers[host]?.(pathname);
    return filePath ? fileResponse(filePath, request) : new Response('Not found', { status: 404 });
  });
}

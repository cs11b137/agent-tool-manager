export const TOKEN_KEY = 'atm.token';

interface LocationLike {
  href: string;
}
interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  state: unknown;
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads `?token=` from the URL, persists it to sessionStorage and strips it from the address bar.
 * Falls back to a previously stored token. Returns null when none is available.
 */
export function extractToken(
  loc: LocationLike = window.location,
  storage: StorageLike = window.sessionStorage,
  history: HistoryLike = window.history,
): string | null {
  const url = new URL(loc.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    storage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    const rest = url.searchParams.toString();
    history.replaceState(history.state, '', url.pathname + (rest ? `?${rest}` : '') + url.hash);
    return fromUrl;
  }
  return storage.getItem(TOKEN_KEY);
}

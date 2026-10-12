import { describe, expect, it, vi } from 'vitest';
import { TOKEN_KEY, extractToken } from './token';

function fakes(href: string, stored: string | null = null) {
  const store = new Map<string, string>();
  if (stored) store.set(TOKEN_KEY, stored);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const history = { state: { idx: 1 }, replaceState: vi.fn() };
  return { loc: { href }, storage, history, store };
}

describe('extractToken', () => {
  it('reads ?token=, stores it in sessionStorage and strips it from the URL', () => {
    const f = fakes('http://127.0.0.1:52817/projects/abc?token=s3cret&tab=mcp#x');
    expect(extractToken(f.loc, f.storage, f.history)).toBe('s3cret');
    expect(f.store.get(TOKEN_KEY)).toBe('s3cret');
    expect(f.history.replaceState).toHaveBeenCalledWith({ idx: 1 }, '', '/projects/abc?tab=mcp#x');
  });

  it('drops the query string entirely when token was the only param', () => {
    const f = fakes('http://localhost:4000/?token=abc');
    extractToken(f.loc, f.storage, f.history);
    expect(f.history.replaceState).toHaveBeenCalledWith(expect.anything(), '', '/');
  });

  it('falls back to the stored token and leaves the URL alone', () => {
    const f = fakes('http://localhost:4000/doctor', 'from-session');
    expect(extractToken(f.loc, f.storage, f.history)).toBe('from-session');
    expect(f.history.replaceState).not.toHaveBeenCalled();
  });

  it('returns null when there is no token anywhere', () => {
    const f = fakes('http://localhost:4000/');
    expect(extractToken(f.loc, f.storage, f.history)).toBeNull();
  });
});

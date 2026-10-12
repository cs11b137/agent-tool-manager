import { useCallback, useSyncExternalStore } from 'react';

/** Locally acknowledged doctor issues (e.g.「保留清单的 MCP」). Purely client-side. */
const KEY = 'atm.ack';
const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
  } catch {
    cache = [];
  }
  return cache;
}

export function useAcknowledged() {
  const ids = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
  const ack = useCallback((id: string) => {
    cache = [...read().filter((x) => x !== id), id];
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  }, []);
  return { ids, ack };
}

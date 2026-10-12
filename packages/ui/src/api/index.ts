import type { ApiClient } from './client';
import { HttpApiClient } from './http';
import { MockApiClient } from './mock';
import { extractToken } from './token';

/** `VITE_ATM_MOCK=1` → in-memory mock (dev default via .env.development); otherwise the real server. */
export function createApiClient(): ApiClient {
  if (import.meta.env.VITE_ATM_MOCK === '1') return new MockApiClient();
  return new HttpApiClient(extractToken());
}

export * from './client';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index';

afterEach(() => vi.unstubAllEnvs());

describe('API data source', () => {
  it('uses the real API by default', () => {
    vi.stubEnv('VITE_ATM_MOCK', undefined);
    expect(createApiClient().kind).toBe('http');
  });

  it('uses the real API when mock is disabled', () => {
    vi.stubEnv('VITE_ATM_MOCK', '0');
    expect(createApiClient().kind).toBe('http');
  });

  it('uses demo data only when explicitly enabled', () => {
    vi.stubEnv('VITE_ATM_MOCK', '1');
    expect(createApiClient().kind).toBe('mock');
  });
});

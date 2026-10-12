import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider } from '../api/context';
import type { ApiClient } from '../api/client';
import { MockApiClient } from '../api/mock';
import { ToastProvider } from '../components/Toaster';
import { LiveProvider } from '../components/LiveProvider';

export function renderWithProviders(ui: ReactNode, opts: { api?: ApiClient; route?: string } = {}) {
  const api = opts.api ?? new MockApiClient({ latency: 0, taskStep: 1 });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const result = render(
    <ApiProvider client={api}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <LiveProvider>
            <MemoryRouter initialEntries={[opts.route ?? '/']}>{ui}</MemoryRouter>
          </LiveProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...result, api, qc };
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/index.css';
import { App } from './App';
import { createApiClient } from './api';
import { ApiProvider } from './api/context';
import { ToastProvider } from './components/Toaster';
import { LiveProvider } from './components/LiveProvider';

const api = createApiClient();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LiveProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </LiveProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ApiProvider>
  </StrictMode>,
);

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from './Library';
import { GlobalPage } from './Global';
import { AddToolFlow } from '../components/flows';
import { MockApiClient } from '../api/mock';
import { IDS } from '../api/mock-data';
import { renderWithProviders } from '../test/utils';

describe('first-run empty state', () => {
  it('shows initialization guidance instead of a search-empty message or demo entries', async () => {
    const api = new MockApiClient({ latency: 0 });
    vi.spyOn(api, 'getLibrary').mockResolvedValue([]);
    vi.spyOn(api, 'getRepos').mockResolvedValue([]);
    vi.spyOn(api, 'getProjects').mockResolvedValue([]);
    renderWithProviders(<LibraryPage />, { api });
    expect(await screen.findByText('还没有添加工具')).toBeInTheDocument();
    expect(screen.queryByText('没有匹配的工具。')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '全部 0' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '新建第一个工具' }));
    expect(await screen.findByRole('dialog', { name: '新建工具' })).toBeInTheDocument();
  });

  it('scans global tools only after an explicit user action', async () => {
    const api = new MockApiClient({ latency: 0 });
    const scan = vi.spyOn(api, 'getGlobal');
    renderWithProviders(<GlobalPage />, { api });
    expect(screen.getByText('尚未扫描本机工具')).toBeInTheDocument();
    expect(scan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '扫描本机工具' }));
    expect(await screen.findByRole('heading', { name: '全局启用的插件' })).toBeInTheDocument();
    expect(scan).toHaveBeenCalledOnce();
  });

  it('discovers native plugins in the explicit add flow without polluting the managed library', async () => {
    const api = new MockApiClient({ latency: 0 });
    const candidate = (await api.getLibrary(undefined, { includeInstalledPlugins: true })).find((item) => item.kind === 'plugin' && item.usedBy.length === 0)!;
    expect(candidate).toBeDefined();
    expect((await api.getLibrary()).some((item) => item.name === candidate.name)).toBe(false);
    const fetchLibrary = vi.spyOn(api, 'getLibrary');
    renderWithProviders(<AddToolFlow projectIds={[IDS.atm]} kind="plugin" onClose={() => {}} />, { api });
    expect(await screen.findByRole('radio', { name: new RegExp(candidate.name.split('@')[0]!) })).toBeInTheDocument();
    await waitFor(() => expect(fetchLibrary).toHaveBeenCalledWith(undefined, { includeInstalledPlugins: true }));
    expect((await api.getLibrary()).some((item) => item.name === candidate.name)).toBe(false);
  });
});

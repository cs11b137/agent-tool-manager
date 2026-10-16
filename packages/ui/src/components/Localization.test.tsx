import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { MockApiClient } from '../api/mock';
import { renderWithProviders } from '../test/utils';
import { msg, setLocale } from '../lib/i18n';
import en from '../locales/en.json';
import zh from '../locales/zh.json';
import { DoctorPage } from '../pages/Doctor';
import { OverviewPage } from '../pages/Overview';

afterEach(() => setLocale('zh-CN'));

describe('navigation and localization', () => {
  it('shows an honest empty health state and removes the overview search', async () => {
    const api = new MockApiClient({ latency: 0 });
    vi.spyOn(api, 'getProjects').mockResolvedValue([]);
    const getDoctor = api.getDoctor.bind(api);
    vi.spyOn(api, 'getDoctor').mockImplementation(((id?: string, opts?: { measure?: boolean }) => {
      if (opts?.measure) return getDoctor(id, { measure: true });
      return Promise.resolve({
        checkedAt: new Date().toISOString(), measured: false,
        counts: { error: 0, warn: 0, info: 0 }, issues: [], projects: [],
      });
    }) as typeof api.getDoctor);
    const view = renderWithProviders(<OverviewPage />, { api });
    expect(await screen.findByText('暂无项目')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    view.unmount();
    renderWithProviders(<DoctorPage />, { api });
    expect(await screen.findByText('暂无项目可检查。添加项目后，可查看工具链接、配置和上下文占用情况。')).toBeInTheDocument();
    expect(screen.queryByText('所有项目都很健康。')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '错误' })).not.toBeInTheDocument();
  });

  it('localizes diagnostic explanations while preserving original details', async () => {
    renderWithProviders(<DoctorPage />);
    expect(await screen.findByText('工具链接失效')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '错误' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '警告' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '提示' })).toBeInTheDocument();
    const details = within(screen.getByRole('region', { name: '错误' })).getByText('原始诊断与处理建议').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('断链');
    await userEvent.click(within(details!).getByText('原始诊断与处理建议'));
    expect(details).toHaveAttribute('open');
    expect(within(details!).getByText('atm install')).toBeInTheDocument();
  });

  it('switches an open settings form without losing input or translating paths', async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/library' });
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const dialog = screen.getByRole('dialog');
    const root = within(dialog).getByLabelText('共享仓库目录');
    await user.clear(root);
    await user.type(root, '/tmp/工具库');
    await user.click(within(dialog).getByRole('button', { name: 'English' }));
    expect(within(dialog).getByRole('heading', { name: 'Update repository' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Shared repository directory')).toHaveValue('/tmp/工具库');
    expect(within(dialog).getByLabelText('MCP registry directory')).toHaveValue('/tmp/工具库/mcp-registry');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('atm.locale')).toBe('en');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Tool library' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Tool assignments' }).length).toBeGreaterThan(0);
  });

  it('searches project shortcuts and preserves project names across languages', async () => {
    const api = new MockApiClient({ latency: 0 });
    const projects = await api.getProjects();
    vi.spyOn(api, 'getProjects').mockResolvedValue(projects.map((p, i) => ({ ...p, name: i === 0 ? '工具库' : p.name })));
    setLocale('en');
    renderWithProviders(<App />, { api, route: '/matrix' });
    const searches = await screen.findAllByRole('searchbox', { name: 'Search projects' });
    await userEvent.type(searches[0]!, '工具库');
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0]!;
    expect(within(nav).getByRole('link', { name: '工具库' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'admin-panel' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tool assignments' })).toBeInTheDocument();
  });

  it('opens mobile navigation and can add a project from the empty sidebar', async () => {
    const api = new MockApiClient({ latency: 0 });
    vi.spyOn(api, 'getProjects').mockResolvedValue([]);
    renderWithProviders(<App />, { api });
    await userEvent.click(await screen.findByRole('button', { name: '打开导航' }));
    const nav = screen.getByRole('dialog');
    await userEvent.click(within(nav).getAllByRole('button', { name: '添加项目' })[0]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAccessibleName('添加项目'));
    expect(screen.getByLabelText('项目目录')).toBeInTheDocument();
    expect(await api.getProjects()).toEqual([]);
  });

  it('preserves interpolation variables and provides English for every revised Chinese message', () => {
    for (const key of Object.keys(zh)) expect(en, key).toHaveProperty(key);
    for (const [key, value] of Object.entries(en)) {
      expect(value.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(key.match(/\{\w+\}/g)?.sort() ?? []);
    }
    setLocale('en');
    expect(msg('写入 {0} 个文件', {0: 3})).toBe('Apply to 3 files');
    expect(msg('unknown diagnostic')).toBe('unknown diagnostic');
  });
});

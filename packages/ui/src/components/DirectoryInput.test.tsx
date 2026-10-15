import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InitSharedDirectoryDialog, RegisterProjectDialog, SettingsDialog } from './dialogs';
import { MockApiClient } from '../api/mock';
import { renderWithProviders } from '../test/utils';

describe('directory selection in forms', () => {
  it('fills the project path without registering it, preserves input on cancel, and supports manual typing', async () => {
    const api = new MockApiClient({ latency: 0 });
    const choose = vi.spyOn(api, 'selectDirectory').mockResolvedValueOnce({ path: '/work/中文 project' }).mockResolvedValueOnce({ path: null });
    const register = vi.spyOn(api, 'registerProject');
    renderWithProviders(<RegisterProjectDialog onClose={() => {}} />, { api });
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
    expect(screen.getByLabelText('项目目录')).toHaveValue('/work/中文 project');
    expect(register).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
    expect(choose).toHaveBeenLastCalledWith('/work/中文 project');
    expect(screen.getByLabelText('项目目录')).toHaveValue('/work/中文 project');
    await userEvent.type(screen.getByLabelText('项目目录'), '/child');
    expect(screen.getByLabelText('项目目录')).toHaveValue('/work/中文 project/child');
  });

  it.each(['settings', 'initialization'])('follows the root and preserves a custom registry in %s', async (mode) => {
    const api = new MockApiClient({ latency: 0 });
    vi.spyOn(api, 'selectDirectory').mockResolvedValueOnce({ path: '/chosen' }).mockResolvedValueOnce({ path: '/custom/registry' }).mockResolvedValueOnce({ path: '/next' });
    renderWithProviders(mode === 'settings' ? <SettingsDialog onClose={() => {}} /> : <InitSharedDirectoryDialog onClose={() => {}} />, { api });
    const root = screen.getByLabelText(mode === 'settings' ? '共享仓库目录' : '共享根目录');
    await waitFor(() => expect(root).toHaveValue('~/.agent-tools'));
    await userEvent.click(screen.getAllByRole('button', { name: '选择文件夹…' })[0]!);
    expect(root).toHaveValue('/chosen');
    expect(screen.getByLabelText('MCP registry 目录')).toHaveValue('/chosen/mcp-registry');
    await userEvent.click(screen.getAllByRole('button', { name: '选择文件夹…' })[1]!);
    await userEvent.click(screen.getAllByRole('button', { name: '选择文件夹…' })[0]!);
    expect(root).toHaveValue('/next');
    expect(screen.getByLabelText('MCP registry 目录')).toHaveValue('/custom/registry');
    expect((await api.getConfig()).root).toBe('/Users/dev/.agent-tools');
  });

  it('blocks submission/dismissal while selecting and allows error retry', async () => {
    const api = new MockApiClient({ latency: 0 });
    let finish!: (result: { path: string | null }) => void;
    const choose = vi.spyOn(api, 'selectDirectory').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error('无法打开系统窗口')).mockResolvedValueOnce({ path: '/chosen' });
    const onClose = vi.fn();
    renderWithProviders(<RegisterProjectDialog onClose={onClose} />, { api });
    await userEvent.type(screen.getByLabelText('项目目录'), '/original');
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
    expect(screen.getByRole('button', { name: '选择中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加项目' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    finish({ path: null });
    await waitFor(() => expect(screen.getByRole('button', { name: '选择文件夹…' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法打开系统窗口');
    expect(screen.getByLabelText('项目目录')).toHaveValue('/original');
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
    expect(screen.getByLabelText('项目目录')).toHaveValue('/chosen');
    expect(choose).toHaveBeenCalledTimes(3);
  });
});

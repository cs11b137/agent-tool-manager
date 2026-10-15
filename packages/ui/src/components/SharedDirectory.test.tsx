import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InitSharedDirectoryDialog, SettingsDialog } from './dialogs';
import { LibraryPage } from '../pages/Library';
import { MockApiClient } from '../api/mock';
import { ApiError } from '../api/client';
import { renderWithProviders } from '../test/utils';

async function ready() {
  const root = await screen.findByLabelText('共享根目录');
  await waitFor(() => expect(root).toHaveValue('~/.agent-tools'));
  return root;
}

describe('shared directory initialization', () => {
  it('library has no initialization entry and settings updates the repository in place', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0 });
    const update = vi.spyOn(api, 'initSharedRepository');
    const onClose = vi.fn();
    renderWithProviders(<><LibraryPage /><SettingsDialog onClose={onClose} /></>, { api });
    expect(screen.queryByRole('button', { name: '创建共享仓库…' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '更新仓库' })).toBeInTheDocument();
    const root = screen.getByLabelText('共享仓库目录');
    await waitFor(() => expect(root).toHaveValue('~/.agent-tools'));
    await user.clear(root);
    expect(screen.getByRole('button', { name: '更新仓库' })).toBeDisabled();
    await user.type(root, '~/my-tools');
    expect(screen.getByLabelText('MCP registry 目录')).toHaveValue('~/my-tools/mcp-registry');
    await user.click(screen.getByRole('checkbox', { name: /Cursor/ }));
    update.mockRejectedValueOnce(new ApiError('CONFLICT', '目标路径被文件占用'));
    await user.click(screen.getByRole('button', { name: '更新仓库' }));
    expect(await screen.findByText('目标路径被文件占用')).toBeInTheDocument();
    expect(root).toHaveValue('~/my-tools');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '更新仓库' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(update).toHaveBeenLastCalledWith({ root: '~/my-tools', mcpRegistry: '~/my-tools/mcp-registry', defaultAgents: ['claude-code', 'cursor'] });
    expect(await screen.findByText('~/my-tools · ~/my-tools/mcp-registry · 已添加的插件')).toBeInTheDocument();
    expect(screen.getByText('仓库已更新')).toBeInTheDocument();
  });

  it('preserves custom registry paths and disables invalid input', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0 });
    await api.patchConfig({ mcpRegistry: '/custom/registry' });
    renderWithProviders(<InitSharedDirectoryDialog onClose={() => {}} />, { api });
    const root = await ready();
    await user.clear(root);
    await user.type(root, 'relative');
    expect(screen.getByRole('button', { name: '创建并保存' })).toBeDisabled();
    await user.clear(root);
    await user.type(root, '~/other');
    expect(screen.getByLabelText('MCP registry 目录')).toHaveValue('/custom/registry');
    expect(screen.getByRole('button', { name: '创建并保存' })).toBeEnabled();
  });

  it('retains input on error, permits retry, and blocks edits or dismissal while pending', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0 });
    const onClose = vi.fn();
    const init = vi.spyOn(api, 'initSharedRepository').mockRejectedValueOnce(new ApiError('CONFLICT', '目标路径被文件占用'));
    renderWithProviders(<InitSharedDirectoryDialog onClose={onClose} />, { api });
    const root = await ready();
    await user.click(screen.getByRole('button', { name: '创建并保存' }));
    expect(await screen.findByText('目标路径被文件占用')).toBeInTheDocument();
    expect(root).toHaveValue('~/.agent-tools');
    expect(onClose).not.toHaveBeenCalled();
    const cfg = await api.getConfig();
    let finish!: (value: typeof cfg) => void;
    init.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.click(screen.getByRole('button', { name: '创建并保存' }));
    expect(screen.getByRole('button', { name: '创建中…' })).toBeDisabled();
    expect(root).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).not.toHaveBeenCalled();
    finish(cfg);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(init).toHaveBeenCalledTimes(2);
  });
});

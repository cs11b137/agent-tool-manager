import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepositoryGate, CreateToolDialog, SharedRepositoryPanel } from './SharedRepository';
import { MockApiClient } from '../api/mock';
import { renderWithProviders } from '../test/utils';

describe('shared repository workflow', () => {
  it('navigates tool types without submitting and dismisses the menu before the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<CreateToolDialog onClose={onClose} />);
    const select = screen.getByRole('combobox', { name: '工具类型' });
    await user.click(select);
    expect(screen.getByRole('option', { name: 'Skill' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}{Enter}');
    expect(select).toHaveTextContent('插件（Claude Code）');
    expect(select).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Escape}');
    expect(select).toHaveAttribute('aria-expanded', 'false');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(select);
    await user.click(screen.getByLabelText('名称'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(select);
    await user.keyboard('{Tab}');
    expect(screen.getByLabelText('名称')).toHaveFocus();
    expect(select).toHaveAttribute('aria-expanded', 'false');
  });

  it('blocks the application until initialization succeeds and preserves the form after failure', async () => {
    const api = new MockApiClient({ latency: 0 });
    const status = await api.getSharedRepository();
    let initialized = false;
    vi.spyOn(api, 'getSharedRepository').mockImplementation(async () => ({ ...status, initialized }));
    vi.spyOn(api, 'initSharedRepository').mockRejectedValueOnce(new Error('目录不可写')).mockImplementationOnce(async () => { initialized = true; return api.getConfig(); });
    renderWithProviders(<RepositoryGate><div>管理器内容</div></RepositoryGate>, { api });
    await userEvent.click(await screen.findByRole('button', { name: '创建共享仓库' }));
    expect(screen.queryByText('管理器内容')).not.toBeInTheDocument();
    const save = await screen.findByRole('button', { name: '创建并保存' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText('目录不可写')).toBeInTheDocument();
    expect(screen.getByLabelText('共享根目录')).toHaveValue('~/.agent-tools');
    await userEvent.click(save);
    expect(await screen.findByText('管理器内容')).toBeInTheDocument();
  });

  it('creates plugin instructions and retains input for a duplicate retry', async () => {
    const api = new MockApiClient({ latency: 0 });
    const create = vi.spyOn(api, 'createSharedTool').mockRejectedValueOnce(new Error('工具已存在'));
    const onClose = vi.fn();
    renderWithProviders(<CreateToolDialog onClose={onClose} />, { api });
    await userEvent.click(screen.getByRole('combobox', { name: '工具类型' }));
    await userEvent.click(screen.getByRole('option', { name: '插件（Claude Code）' }));
    await userEvent.type(screen.getByLabelText('名称'), 'team');
    await userEvent.type(screen.getByLabelText('描述'), 'Team guide');
    await userEvent.type(screen.getByLabelText('工具指令'), 'Follow team rules');
    await userEvent.click(screen.getByRole('button', { name: '创建工具' }));
    expect(await screen.findByText('工具已存在')).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('team');
    await userEvent.click(screen.getByRole('button', { name: '创建工具' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(create).toHaveBeenLastCalledWith({ kind: 'plugin', name: 'team', description: 'Team guide', content: 'Follow team rules' });
  });

  it('does not push while saving or committing and permits push retry', async () => {
    const api = new MockApiClient({ latency: 0 });
    const push = vi.spyOn(api, 'pushSharedRepository').mockRejectedValueOnce(new Error('认证失败'));
    renderWithProviders(<SharedRepositoryPanel />, { api });
    await userEvent.type(await screen.findByLabelText('远程仓库地址'), 'git@github.com:test/tools.git');
    await userEvent.click(screen.getByRole('button', { name: '保存远程地址' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存远程地址' })).toBeEnabled());
    expect(push).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('提交说明'), 'First tools');
    await userEvent.click(screen.getByRole('button', { name: '提交改动' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '推送' })).toBeEnabled());
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '推送' }));
    expect(await screen.findByText('认证失败')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '推送' }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
  });
});

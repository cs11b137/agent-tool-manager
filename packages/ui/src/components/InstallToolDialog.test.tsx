import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockApiClient } from '../api/mock';
import { renderWithProviders } from '../test/utils';
import { InstallToolDialog } from './InstallToolDialog';
import type { ToolPackageResult } from '../api/types';

const preview: ToolPackageResult = { installed: false, sha256: 'a'.repeat(64), totalBytes: 40, tools: [{ name: 'review', kind: 'skill', path: '/shared/skills/review', files: 2, conflict: false }] };

describe('tool installation dialog', () => {
  it('uploads a file, previews tools, then submits the same bytes and digest on confirmation', async () => {
    const user = userEvent.setup(), api = new MockApiClient({ latency: 0 }), close = vi.fn();
    const install = vi.spyOn(api, 'importToolPackage').mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, installed: true });
    renderWithProviders(<InstallToolDialog mode="upload" onClose={close} />, { api });
    await user.upload(screen.getByLabelText('本地工具文件'), new File(['zip'], 'tools.zip', { type: 'application/zip' }));
    await user.click(screen.getByRole('button', { name: '预览工具包' }));
    expect(await screen.findByText('review')).toBeInTheDocument();
    expect(install).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认安装' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(install.mock.calls[0]![0]).toEqual({ source: { type: 'upload', filename: 'tools.zip', base64: 'emlw' } });
    expect(install.mock.calls[1]![0]).toEqual({ source: install.mock.calls[0]![0].source, sha256: preview.sha256, selection: ['skill:review'] });
  });
  it('disables conflicting installs and allows selecting a different URL', async () => {
    const user = userEvent.setup(), api = new MockApiClient({ latency: 0 });
    const install = vi.spyOn(api, 'importToolPackage').mockResolvedValue({ ...preview, tools: preview.tools.map((t) => ({ ...t, conflict: true })) });
    renderWithProviders(<InstallToolDialog mode="url" onClose={vi.fn()} />, { api });
    await user.type(screen.getByLabelText('工具地址或 MCP 包名'), 'https://example.com/tools.zip');
    await user.click(screen.getByRole('button', { name: '预览工具包' }));
    expect(await screen.findByText('已存在，无法覆盖')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认安装' })).toBeDisabled();
    expect(install).toHaveBeenCalledWith({ source: { type: 'url', url: 'https://example.com/tools.zip' } });
    await user.click(screen.getByRole('button', { name: '重新选择' }));
    expect(screen.getByLabelText('工具地址或 MCP 包名')).toBeInTheDocument();
  });
  it('keeps download failures visible and allows retrying', async () => {
    const user = userEvent.setup(), api = new MockApiClient({ latency: 0 });
    vi.spyOn(api, 'importToolPackage').mockRejectedValueOnce(new Error('Download failed')).mockResolvedValueOnce(preview);
    renderWithProviders(<InstallToolDialog mode="url" onClose={vi.fn()} />, { api });
    await user.type(screen.getByLabelText('工具地址或 MCP 包名'), 'https://example.com/tools.zip');
    await user.click(screen.getByRole('button', { name: '预览工具包' }));
    expect(await screen.findByText('Download failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览工具包' }));
    expect(await screen.findByText('review')).toBeInTheDocument();
  });
  it('rejects oversized uploads before reading them or calling the API', async () => {
    const user = userEvent.setup(), api = new MockApiClient({ latency: 0 });
    const install = vi.spyOn(api, 'importToolPackage');
    renderWithProviders(<InstallToolDialog mode="upload" onClose={vi.fn()} />, { api });
    const file = new File(['zip'], 'tools.zip'); Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByLabelText('本地工具文件'), file);
    await user.click(screen.getByRole('button', { name: '预览工具包' }));
    expect(await screen.findByText('工具包不能为空且不能超过 20 MB')).toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });
});

it('searches external sources, previews a result and installs the selected tool', async () => {
  const user = userEvent.setup(), api = new MockApiClient({ latency: 0 }), close = vi.fn();
  const source = { type: 'github' as const, repo: 'team/tools', path: 'skills/review' };
  const search = vi.spyOn(api, 'searchExternalTools').mockResolvedValue({ items: [{ id: 'review', name: 'Repo Review', description: 'Review skill', provider: 'GitHub', url: 'https://github.com/team/tools', source }], warnings: [] });
  const install = vi.spyOn(api, 'importToolPackage').mockResolvedValue(preview);
  renderWithProviders(<InstallToolDialog mode="search" onClose={close} />, { api });
  await user.type(screen.getByLabelText('搜索第三方工具'), 'review');
  await user.click(screen.getByRole('button', { name: '搜索工具' }));
  expect(await screen.findByText('Repo Review')).toBeInTheDocument();
  expect(search).toHaveBeenCalledWith({ query: 'review', kind: 'skill' });
  await user.click(screen.getByRole('button', { name: '预览安装' }));
  expect(await screen.findByRole('checkbox', { name: 'review' })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'review' }));
  expect(screen.getByRole('button', { name: '确认安装' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'review' }));
  await user.click(screen.getByRole('button', { name: '确认安装' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(install).toHaveBeenLastCalledWith({ source, sha256: preview.sha256, selection: ['skill:review'] });
});

it('passes native GitHub revision and subdirectory options without requiring a ZIP URL', async () => {
  const user = userEvent.setup(), api = new MockApiClient({ latency: 0 });
  const install = vi.spyOn(api, 'importToolPackage').mockResolvedValue(preview);
  renderWithProviders(<InstallToolDialog mode="github" onClose={vi.fn()} />, { api });
  await user.type(screen.getByLabelText('GitHub 仓库地址'), 'team/tools');
  await user.type(screen.getByLabelText('分支、标签或提交（可选）'), 'v1.0.0');
  await user.type(screen.getByLabelText('仓库内路径（可选）'), 'skills/review');
  await user.click(screen.getByRole('button', { name: '预览工具包' }));
  await screen.findByRole('checkbox', { name: 'review' });
  expect(install).toHaveBeenCalledWith({ source: { type: 'github', repo: 'team/tools', ref: 'v1.0.0', path: 'skills/review' } });
});

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WriteFlow } from './WriteFlow';
import { PinDialog, SettingsDialog } from './dialogs';
import { AddToolFlow } from './flows';
import { LibraryPage } from '../pages/Library';
import { renderWithProviders } from '../test/utils';
import { MockApiClient } from '../api/mock';
import { IDS } from '../api/mock-data';
import type { WritePreview } from '../lib/changes';

const empty: WritePreview = { files: [], warnings: [], commands: [], errors: [] };

describe('CLI flags reachable from the UI', () => {
  it('WriteFlow passes the chosen --adopt / --force / --strict to preview and commit', async () => {
    const user = userEvent.setup();
    const seen: Array<{ adopt: boolean; force: boolean; strict: boolean }> = [];
    const preview = vi.fn().mockImplementation((o) => {
      seen.push(o);
      return Promise.resolve(empty);
    });
    renderWithProviders(<WriteFlow open onClose={() => {}} eyebrow="x" title="t" writeOptions={['strict', 'adopt', 'force']} preview={preview} commit={vi.fn()} />);
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(seen[0]).toEqual({ adopt: false, force: false, strict: false });
    await user.click(screen.getByRole('checkbox', { name: /接管同名的手写条目/ }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(seen[1]).toEqual({ adopt: true, force: false, strict: false });
    await user.click(screen.getByRole('checkbox', { name: /严格模式/ }));
    await waitFor(() => expect(seen[2]).toEqual({ adopt: true, force: false, strict: true }));
  });

  it('adding an MCP that clashes with a hand-written entry needs --adopt, and the UI can tick it', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    await api.saveMcpDef({ name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' }, 'registry');
    await expect(api.addTool(IDS.webApp, { kind: 'mcp', name: 'github' }, { dryRun: true })).rejects.toMatchObject({ code: 'CONFLICT' });

    renderWithProviders(<AddToolFlow onClose={() => {}} projectIds={[IDS.webApp]} kind="mcp" />, { api });
    await user.click(await screen.findByRole('radio', { name: /github/ }));
    await user.click(screen.getByRole('button', { name: '下一步：预览 diff' }));
    expect(await screen.findByText(/中已有手写的 MCP/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /写入/ })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /接管同名的手写条目/ }));
    await waitFor(() => expect(screen.queryByText(/中已有手写的 MCP/)).not.toBeInTheDocument());
    expect(await screen.findByText(/等价命令：atm add mcp github --adopt/)).toBeInTheDocument();
  });

  it('add skill offers a --rev field and records it in the spec', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    const spy = vi.spyOn(api, 'addTool');
    renderWithProviders(<AddToolFlow onClose={() => {}} projectIds={[IDS.atm]} kind="skill" />, { api });
    const radios = await screen.findAllByRole('radio');
    await user.click(radios[0]!);
    await user.click(screen.getByRole('button', { name: '下一步：预览 diff' }));
    await user.type(await screen.findByLabelText(/固定版本/), 'v2.0.0');
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(IDS.atm, expect.objectContaining({ kind: 'skill', rev: 'v2.0.0' }), expect.objectContaining({ dryRun: true })));
  });

  it('pin dryRun previews without writing; the real call records the rev', async () => {
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    const before = (await api.getProject(IDS.webApp)).tools.find((t) => t.name === 'baoyu-comic')!;
    const dry = await api.pin(IDS.webApp, 'baoyu-comic', 'v9.9.9', { dryRun: true });
    expect(dry.applied).toBe(false);
    expect((await api.getProject(IDS.webApp)).tools.find((t) => t.name === 'baoyu-comic')!.skill?.rev).toBe(before.skill?.rev);
    const real = await api.pin(IDS.webApp, 'baoyu-comic', 'v9.9.9');
    expect(real.applied).toBe(true);
    expect((await api.getProject(IDS.webApp)).tools.find((t) => t.name === 'baoyu-comic')!.skill?.rev).toBe('v9.9.9');
  });

  it('PinDialog hands the revision back for the diff step', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    const project = (await api.getProjects()).find((p) => p.id === IDS.webApp)!;
    const onSubmit = vi.fn();
    renderWithProviders(<PinDialog project={project} skill="baoyu-comic" onSubmit={onSubmit} onClose={() => {}} />, { api });
    const next = screen.getByRole('button', { name: '下一步：预览 diff' });
    expect(next).toBeDisabled();
    await user.type(screen.getByLabelText(/版本/), ' v1.4.0 ');
    await user.click(next);
    expect(onSubmit).toHaveBeenCalledWith('v1.4.0');
  });

  it('SettingsDialog edits the global config (root, registry, default agents)', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    const onClose = vi.fn();
    renderWithProviders(<SettingsDialog onClose={onClose} />, { api });
    const root = await screen.findByLabelText('共享仓库目录');
    await waitFor(() => expect((root as HTMLInputElement).value).toContain('GitHub'));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    await user.clear(root);
    await user.type(root, '~/repos');
    await user.click(screen.getByRole('checkbox', { name: /Cursor/ }));
    await user.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const cfg = await api.getConfig();
    expect(cfg.root).toContain('repos');
    expect(cfg.defaultAgents).toContain('cursor');
  });

  it('Library lists shared repos with a per-repo sync button (atm sync <repo>)', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    const spy = vi.spyOn(api, 'sync');
    renderWithProviders(<LibraryPage />, { api });
    await user.click(await screen.findByRole('button', { name: 'sync jimliu/baoyu-skills' }));
    expect(spy).toHaveBeenCalledWith(['jimliu/baoyu-skills']);
  });
});

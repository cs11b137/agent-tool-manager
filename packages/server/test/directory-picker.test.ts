import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAtm } from '@atm/core';
import { createDirectoryPicker } from '../src/directory-picker.js';
import { createApp } from '../src/app.js';
import { mkTmp } from './helpers.js';

describe('native directory picker', () => {
  it('passes paths as arguments and opens the nearest existing parent without creating directories', async () => {
    const home = await mkTmp();
    const selected = path.join(home, '中文 folder " $(echo ignored)');
    await fs.mkdir(selected);
    const run = vi.fn().mockResolvedValue(selected + '/\n');
    const pick = createDirectoryPicker({ home, platform: 'darwin', run });
    expect(await pick('~/missing/new')).toEqual({ path: selected });
    expect(run.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(run.mock.calls[0]?.[1].at(-1)).toBe(home);
    expect(run.mock.calls[0]?.[1][1]).not.toContain(home);
    await expect(fs.stat(path.join(home, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await pick(selected);
    expect(run.mock.calls[1]?.[1].at(-1)).toBe(selected);
  });

  it('returns null on cancellation and permits retry after failure', async () => {
    const home = await mkTmp();
    const run = vi.fn().mockResolvedValueOnce('\n').mockRejectedValueOnce(new Error('no display')).mockResolvedValueOnce(home + '\n');
    const pick = createDirectoryPicker({ home, platform: 'darwin', run });
    expect(await pick()).toEqual({ path: null });
    await expect(pick()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await pick()).toEqual({ path: home });
  });

  it('rejects files and invalid input, and serializes concurrent dialogs', async () => {
    const home = await mkTmp();
    const file = path.join(home, 'file');
    await fs.writeFile(file, 'test');
    const run = vi.fn().mockResolvedValue(file + '\n');
    const pick = createDirectoryPicker({ home, platform: 'darwin', run });
    await expect(pick('relative')).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(pick('~/bad\0')).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    expect(run).not.toHaveBeenCalled();
    await expect(pick()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    let finish!: (s: string) => void;
    run.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = pick();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(pick()).rejects.toMatchObject({ code: 'LOCKED' });
    finish('');
    expect(await pending).toEqual({ path: null });
  });

  it('supports Linux cancellation and a missing zenity fallback, and Windows uses an environment path', async () => {
    const home = await mkTmp();
    const run = vi.fn().mockRejectedValueOnce({ code: 'ENOENT' }).mockResolvedValueOnce(home + '\n').mockRejectedValueOnce({ code: 1 });
    const pick = createDirectoryPicker({ home, platform: 'linux', run });
    expect(await pick()).toEqual({ path: home });
    expect(run.mock.calls[1]?.[0]).toBe('kdialog');
    expect(await pick()).toEqual({ path: null });
    run.mockResolvedValueOnce('');
    await createDirectoryPicker({ home, platform: 'win32', run })();
    const call = run.mock.calls.at(-1)!;
    expect(call[0]).toBe('powershell.exe');
    expect(call[2].ATM_DIRECTORY_PICKER_INITIAL).toBe(home);
  });
});

describe('directory picker endpoint', () => {
  it('requires token and same-origin, validates input, and never writes config', async () => {
    const home = await mkTmp();
    const atm = createAtm({ home });
    const selectDirectory = vi.fn().mockResolvedValue({ path: home });
    const app = createApp({ atm, token: 'test', selectDirectory });
    const post = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer test' }) => app.request('http://127.0.0.1/api/dialogs/select-directory', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({}, {})).status).toBe(401);
    expect((await post({}, { Authorization: 'Bearer test', Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await post({ initialPath: 42 })).status).toBe(400);
    expect((await post({ initialPath: '~/bad\0' })).status).toBe(400);
    expect((await post({ command: 'bad' })).status).toBe(400);
    expect(selectDirectory).not.toHaveBeenCalled();
    const response = await post({ initialPath: '~/.agent-tools' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: home });
    expect(selectDirectory).toHaveBeenCalledWith('~/.agent-tools');
    selectDirectory.mockResolvedValueOnce({ path: null });
    expect(await (await post({})).json()).toEqual({ path: null });
    expect(await fs.readdir(home)).toEqual([]);
  });
});

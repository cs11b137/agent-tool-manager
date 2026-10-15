import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtmError } from '@atm/core';

export interface DirectorySelection { path: string | null }
export type PickerRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
const run: PickerRunner = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, { env: env ?? process.env, timeout: 300_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

// Paths are arguments, never interpolated into executable scripts.
const macScript = `on run argv
  try
    set chosen to choose folder with prompt "选择文件夹" default location (POSIX file (item 1 of argv)) with invisibles
    return POSIX path of chosen
  on error number -128
    return ""
  end try
end run`;
const windowsScript = `Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择文件夹'
$dialog.SelectedPath = $env:ATM_DIRECTORY_PICKER_INITIAL
$dialog.ShowNewFolderButton = $true
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally { $dialog.Dispose() }`;

async function initialDirectory(input: string | undefined, home: string): Promise<string> {
  const value = input?.trim() || home;
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  if (expanded.includes('\0') || !path.isAbsolute(expanded)) throw new AtmError('INVALID_MANIFEST', '请选择绝对路径或 ~/ 开头的目录');
  let candidate = path.resolve(expanded);
  for (;;) {
    if (await fs.stat(candidate).then((s) => s.isDirectory(), () => false)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return home;
    candidate = parent;
  }
}

/** One native picker per server process; cancelling never changes configuration. */
export function createDirectoryPicker(options: { platform?: NodeJS.Platform; home?: string; run?: PickerRunner } = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const execute = options.run ?? run;
  let busy = false;
  return async (initialPath?: string): Promise<DirectorySelection> => {
    if (busy) throw new AtmError('LOCKED', '文件夹选择窗口已打开，请先完成或取消选择');
    busy = true;
    try {
      const initial = await initialDirectory(initialPath, home);
      let output: string;
      if (platform === 'darwin') output = await execute('/usr/bin/osascript', ['-e', macScript, initial]);
      else if (platform === 'win32') output = await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', windowsScript], { ...process.env, ATM_DIRECTORY_PICKER_INITIAL: initial });
      else if (platform === 'linux') {
        try { output = await execute('zenity', ['--file-selection', '--directory', '--title=选择文件夹', `--filename=${initial}/`]); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          output = await execute('kdialog', ['--getexistingdirectory', initial, '--title', '选择文件夹']);
        }
      } else throw new AtmError('UNSUPPORTED', '当前系统不支持文件夹选择，请手动输入路径');
      // Remove the command's output newline, not whitespace belonging to a folder name.
      const selected = output.replace(/\r?\n$/, '');
      if (!selected) return { path: null };
      if (!path.isAbsolute(selected) || !(await fs.stat(selected)).isDirectory()) throw new Error('所选路径不是可用目录');
      return { path: path.resolve(selected) };
    } catch (e) {
      if (platform === 'linux' && (e as { code?: unknown }).code === 1) return { path: null };
      if (e instanceof AtmError) throw e;
      throw new AtmError('UNSUPPORTED', '无法打开系统文件夹选择窗口，请重试或手动输入路径', { cause: e });
    } finally { busy = false; }
  };
}

export const selectDirectory = createDirectoryPicker();

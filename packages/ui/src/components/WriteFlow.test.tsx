import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WriteFlow } from './WriteFlow';
import { renderWithProviders } from '../test/utils';
import type { FileChange } from '../api/types';
import type { WritePreview } from '../lib/changes';
import { unifiedDiff } from '../lib/diff';

function change(relPath: string, before: string, after: string, agent?: FileChange['agent']): FileChange {
  return { path: `/p/${relPath}`, relPath, type: 'file', before, after, ...unifiedDiff(before, after, relPath), ...(agent ? { agent } : {}) };
}

const preview: WritePreview = {
  files: [
    { key: 'a', label: 'tools.json', change: change('.agents/tools.json', '{\n  "mcp": []\n}\n', '{\n  "mcp": ["linear"]\n}\n') },
    { key: 'b', label: '.mcp.json', change: change('.mcp.json', '{}\n', '{\n  "linear": {}\n}\n', 'claude-code') },
  ],
  warnings: ['Cursor 的变量引用写法 ${env:VAR} 尚待验证'],
  commands: ['atm add mcp linear'],
  errors: [],
};

describe('WriteFlow (添加工具 · diff 确认)', () => {
  it('walks 选择 → 预览改动 → 写入 and only writes after confirmation', async () => {
    const user = userEvent.setup();
    const previewFn = vi.fn().mockResolvedValue(preview);
    const commitFn = vi.fn().mockResolvedValue(undefined);
    const onCommitted = vi.fn();
    renderWithProviders(
      <WriteFlow
        open
        onClose={() => {}}
        eyebrow="web-app · 添加工具"
        title="linear"
        select={{ content: <p>pick something</p>, canContinue: true }}
        preview={previewFn}
        commit={commitFn}
        onCommitted={onCommitted}
      />,
    );

    // step 1
    expect(screen.getByText('选择').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('pick something')).toBeInTheDocument();
    expect(previewFn).not.toHaveBeenCalled();

    // step 2: dryRun preview
    await user.click(screen.getByRole('button', { name: '下一步：预览改动' }));
    expect(screen.getByText('预览改动').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(previewFn).toHaveBeenCalledTimes(1);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['tools.json+1 −1', '.mcp.json+3 −1']);
    // the agent config tab is selected by default; switch to the manifest
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    await user.click(tabs[0]!);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('"mcp": ["linear"]');
    expect(screen.getByText(/尚待验证/)).toBeInTheDocument();
    expect(screen.getByText('等价命令：atm add mcp linear')).toBeInTheDocument();
    expect(commitFn).not.toHaveBeenCalled();

    // step 3: write
    await user.click(screen.getByRole('button', { name: '写入 2 个文件' }));
    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已写入 2 个文件/)).toBeInTheDocument();
    expect(screen.getByText('写入').closest('li')).toHaveAttribute('aria-current', 'step');
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
  });

  it('starts on the preview step when selection happened elsewhere and surfaces dryRun errors', async () => {
    const previewFn = vi.fn().mockRejectedValue(new Error('另一个 atm 进程正在写'));
    renderWithProviders(<WriteFlow open onClose={() => {}} eyebrow="工具关联" title="2 处改动" preview={previewFn} commit={vi.fn()} />);
    expect(screen.getByText('预览改动').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(await screen.findByRole('alert')).toHaveTextContent('另一个 atm 进程正在写');
    expect(screen.getByRole('button', { name: /写入/ })).toBeDisabled();
  });
});

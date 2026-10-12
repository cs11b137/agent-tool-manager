import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MatrixPage } from './Matrix';
import { renderWithProviders } from '../test/utils';
import { MockApiClient } from '../api/mock';
import { IDS } from '../api/mock-data';

describe('MatrixPage', () => {
  it('toggles cells into a pending batch, previews the diff, then commits', async () => {
    const user = userEvent.setup();
    const api = new MockApiClient({ latency: 0, taskStep: 1 });
    renderWithProviders(<MatrixPage />, { api });

    const enableLinear = await screen.findByRole('button', { name: '启用 linear 于 web-app' });
    const disableCover = screen.getByRole('button', { name: '停用 baoyu-cover 于 web-app' });
    // missing project cells are not toggleable
    expect(screen.getByRole('button', { name: 'linear 在 old-landing：项目缺失' })).toBeDisabled();

    await user.click(enableLinear);
    expect(enableLinear).toHaveAttribute('data-state', 'pending');
    expect(enableLinear).toHaveTextContent('+');
    expect(screen.getByText('1 处改动待提交 · 涉及 1 个项目')).toBeInTheDocument();

    await user.click(disableCover);
    expect(disableCover).toHaveTextContent('−');
    expect(screen.getByText('2 处改动待提交 · 涉及 1 个项目')).toBeInTheDocument();

    // undo one of them
    await user.click(disableCover);
    expect(disableCover).toHaveAttribute('data-state', 'on');
    expect(screen.getByText('1 处改动待提交 · 涉及 1 个项目')).toBeInTheDocument();

    // nothing written yet
    expect((await api.getProject(IDS.webApp)).tools.some((t) => t.name === 'linear')).toBe(false);

    await user.click(screen.getByRole('button', { name: '预览 diff' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('tab', { name: /tools\.json/ });
    expect(within(dialog).getByRole('tab', { name: /\.cursor\/mcp\.json/ })).toBeInTheDocument();
    expect((await api.getProject(IDS.webApp)).tools.some((t) => t.name === 'linear')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /写入 \d+ 个文件/ }));
    expect(await within(dialog).findByText(/已写入 \d+ 个文件/)).toBeInTheDocument();
    expect((await api.getProject(IDS.webApp)).tools.some((t) => t.name === 'linear')).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    await waitFor(() => expect(screen.queryByText(/处改动待提交/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '停用 linear 于 web-app' })).toHaveAttribute('data-state', 'on'));
  });
});

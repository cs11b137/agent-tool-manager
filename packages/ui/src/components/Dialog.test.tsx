import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from './Dialog';
import { renderWithProviders } from '../test/utils';

describe('Dialog initial focus', () => {
  it('moves Tab and Shift+Tab from the dialog container to its controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Dialog open onClose={() => {}} labelledBy="dialog-title">
        <h2 id="dialog-title">Example</h2>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Example' });
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();

    dialog.focus();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

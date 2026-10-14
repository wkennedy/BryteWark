import { describe, expect, it, vi } from 'vitest';
import { reopenUndoneSend } from '../undo-reopen';

const t = (_k: string, fb?: string, p?: Record<string, string | number | null | undefined>) =>
  (fb ?? '').replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k]));
const draft = { id: 'd' } as never;

describe('reopenUndoneSend', () => {
  it('opens the draft and does not alert on success', async () => {
    const open = vi.fn();
    const alert = vi.fn();
    await reopenUndoneSend({ restore: async () => draft, open, alert, t });
    expect(open).toHaveBeenCalledWith(draft);
    expect(alert).not.toHaveBeenCalled();
  });

  it("names the group's Sent when a group send can't be reopened", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.fn();
    const alert = vi.fn();
    await reopenUndoneSend({ restore: () => Promise.reject(new Error('x')), open, alert, t, group: true, accountName: 'Support' });
    expect(open).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      expect.any(String),
      "Sending was cancelled, but the message couldn't be reopened. It is still in Support's Sent.",
    );
  });

  it('says plain Sent for an own send', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.fn();
    await reopenUndoneSend({ restore: () => Promise.reject(new Error('x')), open: vi.fn(), alert, t });
    expect(alert).toHaveBeenCalledWith(
      expect.any(String),
      "Sending was cancelled, but the message couldn't be reopened. It is still in Sent.",
    );
  });

  it("falls back to the shared account's Sent when a group send has no known name", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.fn();
    await reopenUndoneSend({ restore: () => Promise.reject(new Error('x')), open: vi.fn(), alert, t, group: true });
    expect(alert).toHaveBeenCalledWith(
      expect.any(String),
      "Sending was cancelled, but the message couldn't be reopened. It is still in the shared account's Sent.",
    );
  });
});

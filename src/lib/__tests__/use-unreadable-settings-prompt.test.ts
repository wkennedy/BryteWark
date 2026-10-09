import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));
vi.mock('../../stores/toast-store', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { toast } from '../../stores/toast-store';
import { useSettingsStore } from '../../stores/settings-store';
import { answerUnreadablePrompt } from '../use-unreadable-settings-prompt';

describe('answerUnreadablePrompt', () => {
  const retry = vi.fn(async () => undefined);
  const reset = vi.fn(async () => undefined);
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ retryReadSettings: retry, forceResetUnreadableSettings: reset });
  });

  it.each(['keep', 'reset'] as const)('%s: says the settings were read after all, and does nothing else', async (choice) => {
    useSettingsStore.setState({ settingsReadFailed: false });
    await answerUnreadablePrompt(choice);
    expect(toast.info).toHaveBeenCalledWith('Your settings were read after all');
    expect(retry).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('keep: tries the read again', async () => {
    useSettingsStore.setState({ settingsReadFailed: true });
    await answerUnreadablePrompt('keep');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('reset: resets the unreadable settings', async () => {
    useSettingsStore.setState({ settingsReadFailed: true });
    await answerUnreadablePrompt('reset');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

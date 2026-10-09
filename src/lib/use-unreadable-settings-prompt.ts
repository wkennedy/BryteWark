import { useEffect } from 'react';
import { Alert } from 'react-native';
import { shouldPromptUnreadable, useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { toast } from '../stores/toast-store';

// Once per launch: a second time would only nag.
let promptedThisLaunch = false;

/**
 * A tap on the prompt. The alert can't be taken back once shown, so a read
 * that worked since is said instead of acted on.
 */
export async function answerUnreadablePrompt(choice: 'keep' | 'reset'): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.settingsReadFailed) {
    const t = useLocaleStore.getState().t;
    toast.info(t('settings.unreadable_read_after_all', 'Your settings were read after all'));
    return;
  }
  if (choice === 'keep') await settings.retryReadSettings();
  else await settings.forceResetUnreadableSettings();
}

/**
 * Offers to reset settings the device keeps refusing to read
 * (shouldPromptUnreadable): from the third launch in a row, while the read
 * still fails. Mounted once, in App.
 */
export function useUnreadableSettingsPrompt(): void {
  const prompt = useSettingsStore((s) =>
    shouldPromptUnreadable(s.settingsRefusedLaunches, s.settingsReadFailed, s.settingsReadRefused));

  useEffect(() => {
    if (!prompt || promptedThisLaunch) return;
    promptedThisLaunch = true;
    const t = useLocaleStore.getState().t;
    Alert.alert(
      t('settings.unreadable_title', 'Your settings could not be read'),
      t('settings.unreadable_body', 'Your device refused to read your saved settings three times in a row. You can keep trying, or reset them to the defaults (the old settings cannot be recovered).'),
      [
        {
          text: t('settings.unreadable_keep', 'Keep trying'),
          style: 'cancel',
          onPress: () => { void answerUnreadablePrompt('keep'); },
        },
        {
          text: t('settings.unreadable_reset', 'Reset settings'),
          style: 'destructive',
          onPress: () => { void answerUnreadablePrompt('reset'); },
        },
      ],
    );
  }, [prompt]);
}

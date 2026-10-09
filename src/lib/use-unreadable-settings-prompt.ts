import { useEffect } from 'react';
import { Alert } from 'react-native';
import { shouldPromptUnreadable, useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';

// Once per launch: a second time would only nag.
let promptedThisLaunch = false;

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
          onPress: () => { void useSettingsStore.getState().retryReadSettings(); },
        },
        {
          text: t('settings.unreadable_reset', 'Reset settings'),
          style: 'destructive',
          onPress: () => { void useSettingsStore.getState().forceResetUnreadableSettings(); },
        },
      ],
    );
  }, [prompt]);
}

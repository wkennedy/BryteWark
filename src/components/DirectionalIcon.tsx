import React from 'react';
import { View } from 'react-native';
import { isLayoutRTL } from '../i18n';
import { forwardIconStyle } from '../lib/rtl-layout';

/**
 * Wraps an icon that points the way the reader goes (a back arrow, a
 * forward chevron, previous/next, reply/forward, undo/redo) and mirrors it
 * in a right-to-left layout, as Material does. The mirror sits on this View:
 * on the icon itself react-native-svg would also flip the drawing about its
 * corner and leave it blank (see forwardIconStyle).
 */
export function DirectionalIcon({ children }: { children: React.ReactNode }) {
  return <View style={forwardIconStyle(isLayoutRTL())}>{children}</View>;
}

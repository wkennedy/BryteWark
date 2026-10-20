import React from 'react';
import { PENDING_SCROLL_FALLBACK_MS, windowGrewAtTop } from '../../lib/calendar-scroll-window';

// A step back can widen the window at the top in the same update. The
// rows added above move the list natively (maintainVisibleContentPosition),
// which cancels a scroll already under way and can run after it: the grid
// would stay on the month you left. So that scroll waits until the new
// rows are laid out (the content size changes) and a frame has passed.
//
// Call `noteWindowStart` on every run of the focus effect (it remembers the
// start and says whether the window grew at the top), then
// `scrollAfterNavigation` once a new focus is to be shown.
export function useDeferredFocusScroll(scrollToFocus: React.MutableRefObject<() => void>): {
  onContentSizeChange: () => void;
  noteWindowStart: (windowStart: number) => boolean;
  scrollAfterNavigation: (grewAtTop: boolean) => void;
} {
  // Null until the first run, which has nothing to have grown from.
  const windowStartRef = React.useRef<number | null>(null);
  const pendingScrollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onContentSizeChange = React.useCallback(() => {
    if (pendingScrollRef.current === null) return;
    clearTimeout(pendingScrollRef.current);
    pendingScrollRef.current = null;
    requestAnimationFrame(() => scrollToFocus.current());
  }, [scrollToFocus]);
  React.useEffect(() => () => {
    if (pendingScrollRef.current !== null) clearTimeout(pendingScrollRef.current);
  }, []);
  const noteWindowStart = React.useCallback((windowStart: number) => {
    const grewAtTop = windowStartRef.current !== null && windowGrewAtTop(windowStartRef.current, windowStart);
    windowStartRef.current = windowStart;
    return grewAtTop;
  }, []);
  const scrollAfterNavigation = React.useCallback((grewAtTop: boolean) => {
    if (pendingScrollRef.current !== null) clearTimeout(pendingScrollRef.current);
    pendingScrollRef.current = null;
    if (!grewAtTop) {
      scrollToFocus.current();
      return;
    }
    // Should the content size not report, scroll anyway.
    pendingScrollRef.current = setTimeout(onContentSizeChange, PENDING_SCROLL_FALLBACK_MS);
  }, [scrollToFocus, onContentSizeChange]);
  return { onContentSizeChange, noteWindowStart, scrollAfterNavigation };
}

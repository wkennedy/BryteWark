/**
 * Physical placement helpers for right-to-left layouts.
 *
 * React Native mirrors `left`/`right` and flex start/end under RTL, but a
 * `translateX` and a pan's `dx` stay physical. Anything that slides with a
 * transform, or sits under content that slides, has to undo that mirroring
 * to line up with the motion. Swipe actions themselves stay physical, as in
 * webmail: a rightward drag fires the "right" action in every language.
 */

export interface BandEdgeStyle {
  left?: 0;
  right?: 0;
  alignItems: 'flex-start' | 'flex-end';
  justifyContent: 'flex-start' | 'flex-end';
}

/**
 * Pins a swipe band and its icon to the physical `side` of the row, the
 * edge a drag exposes. Under RTL the logical values are swapped so that RN's
 * own swap lands them back on the physical side.
 */
export function bandEdgeStyle(side: 'left' | 'right', rtl: boolean): BandEdgeStyle {
  const logicalStart = (side === 'left') !== rtl;
  return logicalStart
    ? { left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' }
    : { right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' };
}

/**
 * Where a closed drawer is parked. Drawers are anchored at the start edge
 * (`left: 0`, which RN puts on the right in RTL), so they hide off that side.
 */
export function drawerClosedX(width: number, rtl: boolean): number {
  return rtl ? width : -width;
}

/** Safe-area edges for a start-anchored drawer: its outer edge, never the inner one. */
export function drawerSafeEdges(rtl: boolean): ('top' | 'bottom' | 'left' | 'right')[] {
  return ['top', 'bottom', rtl ? 'right' : 'left'];
}

/**
 * The toggle thumb's offset from the track's start edge. The thumb rests at
 * the start edge, which is the right in RTL, so the offset points left there.
 */
export function toggleThumbX(on: boolean, rtl: boolean): number {
  // Measured inside the track's 1px outline: 4px from its outer edge.
  const x = on ? 23 : 3;
  return rtl ? -x : x;
}

/**
 * Mirrors an icon that points the way the reader goes: a "go into" chevron
 * or a back arrow. Lucide draws them for left-to-right, and RN does not flip
 * icons under RTL, so a forward chevron would point back at the reader.
 * Put it on a View around the icon, never on the icon: react-native-svg
 * also applies an Svg's style transform to the drawing, about its corner,
 * which flips the icon off its own canvas and leaves it blank.
 */
export function forwardIconStyle(rtl: boolean): { transform: [{ scaleX: -1 }] } | undefined {
  return rtl ? { transform: [{ scaleX: -1 }] } : undefined;
}

/**
 * A horizontal list's scroll position measured from its start edge: the
 * left in LTR, the right in RTL. Android reports `contentOffset.x` from the
 * left in both, while FlatList lays a right-to-left list out from the right
 * and takes `scrollToOffset` from the start edge.
 */
export function startEdgeOffset(x: number, contentWidth: number, viewportWidth: number, rtl: boolean): number {
  return rtl ? contentWidth - (x + viewportWidth) : x;
}

import { describe, it, expect } from 'vitest';
import { bandEdgeStyle, drawerClosedX, drawerSafeEdges, forwardIconStyle, startEdgeOffset, toggleThumbX } from '../rtl-layout';
import { resolveRelease } from '../../components/swipe-gesture';

describe('rtl-layout', () => {
  it('pins a band to its physical edge in both directions', () => {
    expect(bandEdgeStyle('left', false)).toEqual({ left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' });
    expect(bandEdgeStyle('left', true)).toEqual({ right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' });
    expect(bandEdgeStyle('right', false)).toEqual({ right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' });
    expect(bandEdgeStyle('right', true)).toEqual({ left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' });
  });

  it('parks a closed drawer off the side it is anchored to', () => {
    expect(drawerClosedX(400, false)).toBe(-400);
    expect(drawerClosedX(400, true)).toBe(400);
  });

  it("keeps the inset on the drawer's own edge", () => {
    expect(drawerSafeEdges(false)).toEqual(['top', 'bottom', 'left']);
    expect(drawerSafeEdges(true)).toEqual(['top', 'bottom', 'right']);
  });

  it('moves the toggle thumb toward the start edge when off', () => {
    expect(toggleThumbX(false, false)).toBe(3);
    expect(toggleThumbX(true, false)).toBe(23);
    expect(toggleThumbX(false, true)).toBe(-3);
    expect(toggleThumbX(true, true)).toBe(-23);
  });

  it('mirrors a forward icon only in RTL', () => {
    expect(forwardIconStyle(true)).toEqual({ transform: [{ scaleX: -1 }] });
    expect(forwardIconStyle(false)).toBeUndefined();
  });

  it('leaves swipe actions physical: a rightward drag still fires rightAction in RTL', () => {
    // The gesture logic takes no direction at all, so RTL cannot remap it.
    const config = { mode: 'instant' as const, leftAction: 'delete' as const, rightAction: 'archive' as const };
    expect(resolveRelease({ dx: 200, dy: 0, vx: 0 }, config, null)).toEqual({ kind: 'fire', action: 'archive', direction: 1 });
    expect(resolveRelease({ dx: -200, dy: 0, vx: 0 }, config, null)).toEqual({ kind: 'fire', action: 'delete', direction: -1 });
  });
});

describe('startEdgeOffset', () => {
  it('measures from the left in LTR and from the right in RTL', () => {
    // 13 pages of 400 wide; the 4th page (index 3) on screen.
    expect(startEdgeOffset(1200, 5200, 400, false)).toBe(1200);
    // In RTL the 4th page sits 4 pages in from the right edge.
    expect(startEdgeOffset(3600, 5200, 400, true)).toBe(1200);
    expect(startEdgeOffset(4800, 5200, 400, true)).toBe(0);
  });
});

// Icons that point the way the reader goes must mirror in right-to-left
// layouts (Material does), and only through <DirectionalIcon>: RN does not
// flip icons, and a transform on the icon itself blanks it (react-native-svg
// also turns the drawing about its corner). This scans the source for a
// directional icon drawn any other way.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const ICONS = ['ArrowLeft', 'ArrowRight', 'ChevronLeft', 'ChevronRight', 'Undo2', 'Redo2', 'Reply', 'ReplyAll', 'Forward'];

// File → icons that stay as drawn on purpose.
const ALLOWED: Record<string, string[]> = {
  // The swipe labels name a physical drag direction, the same in every
  // language (swipes stay physical, as in webmail).
  'src/components/settings/LayoutSettings.tsx': ['ArrowLeft', 'ArrowRight'],
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sources(p, out);
    } else if (entry.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** `file:line Icon` for every directional icon not wrapped in DirectionalIcon. */
export function bareDirectionalIcons(file: string, text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`<(${ICONS.join('|')})\\b`, 'g');
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - '<DirectionalIcon>'.length), m.index);
    if (before === '<DirectionalIcon>') continue;
    if (ALLOWED[file]?.includes(m[1])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    found.push(`${file}:${line} ${m[1]}`);
  }
  return found;
}

describe('directional icons', () => {
  it('flags a bare icon and passes a wrapped one', () => {
    expect(bareDirectionalIcons('x.tsx', '<ChevronRight size={4} />')).toEqual(['x.tsx:1 ChevronRight']);
    expect(bareDirectionalIcons('x.tsx', '<DirectionalIcon><ArrowLeft size={4} /></DirectionalIcon>')).toEqual([]);
    // Not a directional icon.
    expect(bareDirectionalIcons('x.tsx', '<ChevronDown size={4} /><ReplyIcon />')).toEqual([]);
  });

  it('draws every back arrow, forward chevron, reply/forward and undo/redo through DirectionalIcon', () => {
    const files = [...sources(join(ROOT, 'src')), join(ROOT, 'App.tsx')];
    const bare = files.flatMap((p) => {
      const file = relative(ROOT, p).split('\\').join('/');
      return bareDirectionalIcons(file, readFileSync(p, 'utf8'));
    });
    expect(bare).toEqual([]);
  });
});

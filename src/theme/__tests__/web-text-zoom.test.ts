// Android WebView scales page text by the OS font scale on its own (its
// default textZoom is font_scale x 100), past the cap native Text keeps. The
// app's web views set textZoom themselves: the font size setting times the
// OS scale, capped like body text.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { BODY_MAX_FONT_SCALE, FONT_SCALE, webTextZoom } from '../tokens';

const ROOT = join(__dirname, '..', '..', '..');

describe('webTextZoom', () => {
  it('is 100 at the default sizes', () => {
    expect(webTextZoom(1, FONT_SCALE.medium)).toBe(100);
  });

  it('follows the OS scale up to the body cap', () => {
    expect(webTextZoom(1.3, 1)).toBe(130);
    expect(webTextZoom(BODY_MAX_FONT_SCALE, 1)).toBe(150);
    expect(webTextZoom(2, 1)).toBe(150);
  });

  it('keeps an OS scale below 1', () => {
    expect(webTextZoom(0.85, 1)).toBe(85);
  });

  it('applies the font size setting in full on top of the capped OS scale', () => {
    expect(webTextZoom(1, FONT_SCALE.large)).toBe(113);
    expect(webTextZoom(1, FONT_SCALE.small)).toBe(88);
    expect(webTextZoom(2, FONT_SCALE.large)).toBe(169);
  });

  it('treats a missing or broken OS scale as 1', () => {
    expect(webTextZoom(Number.NaN, 1)).toBe(100);
    expect(webTextZoom(0, 1)).toBe(100);
    expect(webTextZoom(-1, 1.125)).toBe(113);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

// Every <WebView> in the app, and whether it sets textZoom. A static check:
// it finds the JSX tag named WebView in App.tsx and src/**/*.tsx, so a
// WebView rendered under another name (an alias, a wrapper component, a
// library's own WebView) is not seen, and it only checks that the prop is
// there, not that it is the useWebTextZoom value.
function webViews(): Array<[string, boolean]> {
  const found: Array<[string, boolean]> = [];
  for (const path of [join(ROOT, 'App.tsx'), ...tsxFiles(join(ROOT, 'src'))]) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('<WebView')) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === 'WebView') {
        const zoom = node.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText(file) === 'textZoom',
        );
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        found.push([`${relative(ROOT, path)}:${line}`, zoom]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

describe('web views', () => {
  const all = webViews();

  it('finds the message body, the editor and the previews', () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it.each(all)('%s sets textZoom', (_where, zoom) => {
    expect(zoom).toBe(true);
  });
});

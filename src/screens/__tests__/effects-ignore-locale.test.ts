// A language switch gives `t` a new identity, and every hook listing it runs
// again. Memos and callbacks should: that is how screens redraw in the new
// language. Effects that fetch, send, schedule or navigate must not, so they
// read `t` (or a callback built on it) through a ref. This scans the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..', '..');

// File, and a piece of code unique to the effect's body.
const GUARDED: Array<[string, string]> = [
  ['src/screens/EmailSourceScreen.tsx', 'fetchRawEmail('],
  ['src/screens/EmailThreadScreen.tsx', 'ensureDetail(activeEmailId)'],
  ['src/screens/FilesScreen.tsx', 'void loadFiles();'],
  ['src/screens/FilesScreen.tsx', 'planFilesOpen('],
  ['src/screens/LoginScreen.tsx', 'usePendingSignInLinkStore.getState().take()'],
  ['src/screens/EmailListScreen.tsx', 'planMailFolderOpen('],
  ['src/screens/ScheduledScreen.tsx', 'void load();'],
  ['src/components/files/FilePreviewModal.tsx', 'cachePreviewFile('],
  ['src/components/email/ReadReceiptBanner.tsx', 'autoAttempted.add(key)'],
];

const HOOK = /^(React\.)?(useEffect|useLayoutEffect|useCallback|useMemo)$/;
// A name bound to the store's `t`, as in `const tr = useLocaleStore((s) => s.t)`.
const STORE_T = /useLocaleStore\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.t\s*\)/;

function hookName(node: ts.Node, file: ts.SourceFile): string | null {
  if (!ts.isCallExpression(node)) return null;
  const name = node.expression.getText(file);
  return HOOK.test(name) ? name.replace('React.', '') : null;
}

function depsOf(call: ts.CallExpression, file: ts.SourceFile): string[] | null {
  const last = call.arguments[call.arguments.length - 1];
  if (call.arguments.length < 2 || !last || !ts.isArrayLiteralExpression(last)) return null;
  return last.elements.map((e) => e.getText(file));
}

// The names that change with the language: `t`, its aliases, and every
// useCallback/useMemo that lists one of them (followed down the chain).
function localeNames(file: ts.SourceFile): Set<string> {
  const names = new Set(['t']);
  const memos: Array<[string, string[]]> = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (STORE_T.test(node.initializer.getText(file))) names.add(node.name.text);
      const kind = hookName(node.initializer, file);
      if (kind === 'useCallback' || kind === 'useMemo') {
        const deps = depsOf(node.initializer as ts.CallExpression, file);
        if (deps) memos.push([node.name.text, deps]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, deps] of memos) {
      if (!names.has(name) && deps.some((d) => names.has(d))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

// "file marker" for each guarded effect whose dependencies change with the
// language, or whose marker is not found inside an effect.
function offenders(list: Array<[string, string]>, sources?: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [path, marker] of list) {
    const text = sources?.[path] ?? readFileSync(join(ROOT, path), 'utf8');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = text.indexOf(marker);
    let effect: ts.CallExpression | null = null;
    // The innermost effect around the marker.
    const visit = (node: ts.Node) => {
      if (at < node.getStart(file) || at >= node.getEnd()) return;
      const kind = hookName(node, file);
      if (kind === 'useEffect' || kind === 'useLayoutEffect') effect = node as ts.CallExpression;
      ts.forEachChild(node, visit);
    };
    if (at >= 0) visit(file);
    const deps = effect ? depsOf(effect, file) : null;
    const names = localeNames(file);
    if (!deps || deps.some((d) => names.has(d))) found.push(`${path} ${marker}`);
  }
  return found;
}

describe('effects and the language', () => {
  it('keeps t out of effects that fetch, send, schedule or navigate', () => {
    expect(offenders(GUARDED)).toEqual([]);
  });

  it('flags an effect that lists t', () => {
    expect(offenders([['x.tsx', 'fetchIt(']], { 'x.tsx': 'useEffect(() => { fetchIt(t("a")); }, [id, t]);' })).toEqual(['x.tsx fetchIt(']);
  });

  it('flags an effect that lists a callback built on t', () => {
    const src = [
      'const tr = useLocaleStore((s) => s.t);',
      'const load = useCallback(() => fetchIt(tr("a")), [tr]);',
      'useEffect(() => { load(); }, [load]);',
    ].join('\n');
    expect(offenders([['x.tsx', 'load();']], { 'x.tsx': src })).toEqual(['x.tsx load();']);
  });

  it('passes an effect that reads t through a ref', () => {
    const src = 'const tRef = useLatestRef(t);\nuseEffect(() => { fetchIt(tRef.current("a")); }, [id]);';
    expect(offenders([['x.tsx', 'fetchIt(']], { 'x.tsx': src })).toEqual([]);
  });

  it('flags a marker that is not inside an effect', () => {
    expect(offenders([['x.tsx', 'gone(']], { 'x.tsx': 'useEffect(() => {}, []);' })).toEqual(['x.tsx gone(']);
  });
});

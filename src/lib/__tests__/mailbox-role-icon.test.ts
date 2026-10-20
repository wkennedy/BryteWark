import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { File, Trash2, Folder, FolderOpen } from 'lucide-react-native';
import { roleIcon, mailboxIcon } from '../mailbox-role-icon';

// The real package is native-only; every icon becomes a distinct stand-in.
vi.mock('lucide-react-native', () => {
  const icons: Record<string, unknown> = {};
  for (const n of [
    'Inbox', 'Send', 'File', 'Trash2', 'Ban', 'Archive', 'Star', 'Folder', 'FolderOpen',
    'Flag', 'Mails', 'StickyNote', 'Clock', 'AlarmClock', 'Users',
  ]) icons[n] = Object.assign(() => null, { displayName: n });
  return icons;
});

const ROOT = join(__dirname, '../../..');

describe('mailbox-role-icon', () => {
  it('uses File for drafts and Trash2 for trash', () => {
    expect(roleIcon('drafts')).toBe(File);
    expect(roleIcon('trash')).toBe(Trash2);
  });
  it('has no icon for an unknown or missing role', () => {
    expect(roleIcon('custom')).toBeUndefined();
    expect(roleIcon(null)).toBeUndefined();
  });
  it('falls back on the folder name, then to a folder', () => {
    expect(mailboxIcon(null, 'Deleted Items', false, false)).toBe(Trash2);
    expect(mailboxIcon(null, 'Projects', true, true)).toBe(FolderOpen);
    expect(mailboxIcon(null, 'Projects', false, false)).toBe(Folder);
  });
  it('is the only role map in the drawer and folder settings', () => {
    for (const f of ['src/components/SidebarDrawer.tsx', 'src/components/settings/FolderSettings.tsx']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      expect(text).toContain('mailbox-role-icon');
      expect(text).not.toMatch(/drafts:\s*File|case 'drafts'/);
    }
  });
});

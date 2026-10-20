import {
  Inbox, Send, File, Trash2, Ban, Archive, Star, Folder, FolderOpen,
  Flag, Mails, StickyNote, Clock, AlarmClock, Users, type LucideIcon,
} from 'lucide-react-native';

// Distinct icons for the special-use roles (#288). One table so the drawer
// and folder settings draw a role the same way.
const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox, sent: Send, drafts: File, trash: Trash2,
  junk: Ban, spam: Ban, archive: Archive, important: Flag, flagged: Star,
  all: Mails, memos: StickyNote, scheduled: Clock, snoozed: AlarmClock, shared: Users,
};

export function roleIcon(role: string | null | undefined): LucideIcon | undefined {
  return role ? ROLE_ICONS[role] : undefined;
}

// Role first, then a name-based guess for servers that don't set roles, then
// a plain folder.
export function mailboxIcon(
  role: string | null | undefined,
  name: string | undefined,
  hasChildren: boolean,
  isExpanded: boolean,
): LucideIcon {
  const byRole = roleIcon(role);
  if (byRole) return byRole;
  const lower = (name ?? '').toLowerCase();
  if (lower.includes('inbox')) return Inbox;
  if (lower.includes('sent')) return Send;
  if (lower.includes('draft')) return File;
  if (lower.includes('trash') || lower.includes('deleted')) return Trash2;
  if (lower.includes('junk') || lower.includes('spam')) return Ban;
  if (lower.includes('archive')) return Archive;
  if (lower.includes('star') || lower.includes('flag')) return Star;
  if (hasChildren) return isExpanded ? FolderOpen : Folder;
  return Folder;
}

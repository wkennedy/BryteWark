import type { Identity } from '../api/types';
import type { SendableIdentities } from '../api/identity';

export type SendIdentity = Identity & { jmapAccountId: string; accountName: string };

/** A shared account's identity id in the app; ids never hold `/`, so it can't collide. */
export function routedIdentityId(jmapAccountId: string, identityId: string): string {
  return `${jmapAccountId}/${identityId}`;
}

/** The account and server-side id an identity is read and submitted with. */
export function routeOfIdentity(identity: SendIdentity): { jmapAccountId: string; identityId: string } {
  const slash = identity.id.indexOf('/');
  if (slash < 0) return { jmapAccountId: identity.jmapAccountId, identityId: identity.id };
  return { jmapAccountId: identity.id.slice(0, slash), identityId: identity.id.slice(slash + 1) };
}

const normalized = (email: string | undefined): string => (email ?? '').trim().toLowerCase();

/** Whether `identity` sends as `address`: exact, or a `*@domain` identity covering the domain. */
export function identitySendsAs(identity: Pick<Identity, 'email'>, address: string): boolean {
  const own = normalized(identity.email);
  const target = normalized(address);
  if (!own || !target) return false;
  if (own.startsWith('*@')) {
    // A malformed `*@` names no domain, so it covers nothing.
    if (own.length <= 2) return false;
    // Only a plain `local@domain` is covered: `a@b@x` would end in `@x` too.
    const at = target.indexOf('@');
    return at > 0 && at === target.lastIndexOf('@') && target.endsWith(own.slice(1));
  }
  return target === own;
}

/**
 * `identitySendsAs`, or a tagged sub-address of the identity's address (`team+tag@x`
 * for `team@x`) as the composer builds one with `delimiter`. A wildcard identity
 * follows the wildcard rules only. The queue's replay check keeps the exact rule.
 */
export function identitySendsAsOrSubaddress(
  identity: Pick<Identity, 'email'>,
  address: string,
  delimiter = '+',
): boolean {
  if (identitySendsAs(identity, address)) return true;
  const own = normalized(identity.email);
  const target = normalized(address);
  if (!delimiter || own.startsWith('*@')) return false;
  const split = (email: string) => {
    const at = email.indexOf('@');
    return at > 0 && at === email.lastIndexOf('@') ? { local: email.slice(0, at), domain: email.slice(at + 1) } : null;
  };
  const a = split(own);
  const b = split(target);
  if (!a || !b || !a.domain || a.domain !== b.domain) return false;
  // The composer replaces an existing tag, so both are compared by their base.
  const cut = b.local.indexOf(delimiter);
  if (cut <= 0 || cut + delimiter.length >= b.local.length) return false;
  const base = (local: string) => (local.includes(delimiter) ? local.slice(0, local.indexOf(delimiter)) : local);
  return b.local.slice(0, cut) === base(a.local);
}

/**
 * Your own identities followed by each shared account's, ids routed. An own
 * identity a shared one duplicates (same address, wildcards aside) is hidden
 * and recorded in `aliases` so a draft or default naming it follows the
 * shared copy, which files in the group's Sent.
 */
export function buildSendIdentities(
  ownAccountId: string,
  accounts: SendableIdentities,
): { list: SendIdentity[]; aliases: Record<string, string> } {
  const decorate = (jmapAccountId: string, id: (i: Identity) => string): SendIdentity[] =>
    (accounts[jmapAccountId]?.identities ?? []).map((i) => ({
      ...i,
      id: id(i),
      jmapAccountId,
      accountName: accounts[jmapAccountId].name,
    }));
  const shared = Object.keys(accounts)
    .filter((a) => a !== ownAccountId)
    .flatMap((a) => decorate(a, (i) => routedIdentityId(a, i.id)));
  const firstByEmail = new Map<string, string>();
  for (const s of shared) {
    const key = normalized(s.email);
    if (!firstByEmail.has(key)) firstByEmail.set(key, s.id);
  }
  const aliases: Record<string, string> = {};
  const own = decorate(ownAccountId, (i) => i.id).filter((i) => {
    const key = normalized(i.email);
    const twin = key.startsWith('*@') ? undefined : firstByEmail.get(key);
    if (twin === undefined) return true;
    aliases[i.id] = twin;
    return false;
  });
  return { list: [...own, ...shared], aliases };
}

export interface IdentitySection { jmapAccountId: string; label: string | null; identities: SendIdentity[] }

/** The list split by account for the From sheet: yours first, unlabelled, then each shared account. */
export function groupSendIdentities(list: SendIdentity[], ownAccountId: string): IdentitySection[] {
  const sections: IdentitySection[] = [{ jmapAccountId: ownAccountId, label: null, identities: [] }];
  for (const identity of list) {
    if (identity.jmapAccountId === ownAccountId) {
      sections[0].identities.push(identity);
      continue;
    }
    let section = sections.find((s) => s.jmapAccountId === identity.jmapAccountId);
    if (!section) {
      section = { jmapAccountId: identity.jmapAccountId, label: identity.accountName, identities: [] };
      sections.push(section);
    }
    section.identities.push(identity);
  }
  return sections;
}

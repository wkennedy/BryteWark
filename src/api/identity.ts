import { jmapClient } from './jmap-client';
import { assertSetResult, requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';
import type { Identity, JMAPMethodCall } from './types';
import type { AccountRef } from './op-scope';
import { sanitizeDisplayName } from '../lib/rfc5322-mailbox';

const USING = [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION];

// A display name that carries an address or a line break produces a malformed
// `From:` on every message sent with the identity (#672); reduce it to the
// bare name before it reaches the server.
function sanitizeIdentityPatch(identity: Partial<Identity>): Partial<Identity> {
  if (typeof identity.name !== 'string') return identity;
  return { ...identity, name: sanitizeDisplayName(identity.name) };
}

/**
 * The identities of `account`: a bare JMAP account id or nothing (the user's
 * own) on the live connection, or a scope, whose connection the read is
 * bound to.
 */
export async function getIdentities(account?: AccountRef): Promise<Identity[]> {
  const at = typeof account === 'object' && account !== null ? account : null;
  const accountId = at?.accountId ?? (account as string | undefined) ?? jmapClient.accountId;
  const calls: JMAPMethodCall[] = [['Identity/get', { accountId }, '0']];
  const res = at
    ? await jmapClient.request(calls, USING, { gen: at.gen })
    : await jmapClient.request(calls, USING);
  const body = requireMethodResult<{ list?: Identity[] }>(res, '0', 'Identity/get');
  return body.list ?? [];
}

export async function createIdentity(
  identity: Partial<Identity>,
): Promise<Identity> {
  const accountId = jmapClient.accountId;
  const cid = 'new-identity';
  const res = await jmapClient.request(
    [['Identity/set', { accountId, create: { [cid]: sanitizeIdentityPatch(identity) } }, '0']],
    USING,
  );
  const body = requireMethodResult(res, '0', 'Identity/set');
  assertSetResult(body, [cid], 'identity');
  const created = body.created?.[cid] as Partial<Identity> | undefined;
  if (!created?.id) throw new Error('Identity/set returned no id');
  // The create echo carries only server-set properties; re-read the full
  // object so the caller gets name/email/signature back.
  const all = await getIdentities();
  return all.find((i) => i.id === created.id) ?? ({ ...identity, ...created } as Identity);
}

export async function updateIdentity(
  id: string,
  changes: Partial<Identity>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/set', { accountId, update: { [id]: sanitizeIdentityPatch(changes) } }, '0']],
    USING,
  );
  assertSetResult(requireMethodResult(res, '0', 'Identity/set'), [id], 'identity');
}

export async function deleteIdentity(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/set', { accountId, destroy: [id] }, '0']],
    USING,
  );
  assertSetResult(requireMethodResult(res, '0', 'Identity/set'), [id], 'identity');
}

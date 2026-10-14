import { jmapClient } from './jmap-client';
import { assertSetResult, requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';
import type { Identity, JMAPMethodCall } from './types';
import { opScope, type AccountRef, type OpScope } from './op-scope';
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

export interface AccountIdentities { name: string; identities: Identity[] }
/** Keyed by JMAP account id; always holds the scope's own account. */
export type SendableIdentities = Record<string, AccountIdentities>;

/**
 * The identities you can send from, per account: your own, plus those of
 * every other session account advertising submission, in one request. A
 * folder-only share advertises the capability but answers `forbidden`;
 * capability is not permission, so an account whose read errors is left out.
 */
export async function getSendIdentities(at: OpScope = opScope()): Promise<SendableIdentities> {
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const ids = [
    at.accountId,
    ...Object.keys(accounts).filter(
      (id) => id !== at.accountId && accounts[id]?.accountCapabilities?.[CAPABILITIES.SUBMISSION] !== undefined,
    ),
  ];
  const calls: JMAPMethodCall[] = ids.map((accountId, i) => ['Identity/get', { accountId }, String(i)]);
  const res = await jmapClient.request(calls, USING, { gen: at.gen });
  const result: SendableIdentities = {};
  ids.forEach((id, i) => {
    const callId = String(i);
    if (i === 0) {
      const body = requireMethodResult<{ list?: Identity[] }>(res, callId, 'Identity/get');
      result[id] = { name: jmapClient.getAccountName(id) ?? id, identities: body.list ?? [] };
      return;
    }
    const match = (res?.methodResponses ?? []).find((r) => r[2] === callId);
    if (!match || match[0] !== 'Identity/get') return;
    const list = (match[1] as { list?: Identity[] }).list ?? [];
    result[id] = { name: jmapClient.getAccountName(id) ?? id, identities: list };
  });
  return result;
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

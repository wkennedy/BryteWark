/**
 * Routed sends (sending as a group from the group's own account) against a
 * real Stalwart. Opt-in: skipped unless `STALWART_IT_URL` is set. Run it with
 * `scripts/stalwart-shared-send-it.sh`, which starts a throwaway container,
 * provisions alice/bob/carol, the group team@ (bob a member) and a
 * folder-only share from alice to bob, then runs this file and removes the
 * container. Bob connects with the real `jmapClient`; alice with a second
 * client, only to read what she received.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { JMAPClient, jmapClient } from '../jmap-client';
import { getIdentities, getSendIdentities } from '../identity';
import { uploadBytes } from '../blob';
import { createDraft, getFullEmails, getFullEmailsWithState, queryEmails } from '../email';
import { resolveSendMailboxes } from '../sent-lookup';
import { inAccount, opScope, type OpScope } from '../op-scope';
import { sendRouted, RoutedSendError } from '../../lib/routed-send';
import type { Identity } from '../types';

const URL = process.env.STALWART_IT_URL ?? '';
const PASS = process.env.STALWART_IT_PASSWORD ?? '';
const BOB = process.env.STALWART_IT_BOB ?? 'bob@example.org';
const ALICE = process.env.STALWART_IT_ALICE ?? 'alice@example.org';
const TEAM = process.env.STALWART_IT_TEAM ?? 'team@example.org';
// Set by the script when it could provision alice's folder-only share.
const FOLDER_SHARE = process.env.STALWART_IT_FOLDER_SHARE === '1';

const alice = new JMAPClient();
let base: OpScope;
let bobId = '';
let teamId = '';
let teamScope: OpScope;
let teamIdentity: Identity;
let bobSent = '';
let bobDrafts = '';
let teamSent = '';

function accountIdNamed(client: JMAPClient, name: string): string | undefined {
  const accounts = client.currentSession?.accounts ?? {};
  return Object.keys(accounts).find((id) => accounts[id]?.name === name);
}

/** Every email id in an account (small test accounts: one page is all). */
async function allEmailIds(at: OpScope): Promise<string[]> {
  return (await queryEmails(undefined, { limit: 500 }, at)).ids;
}

async function idsIn(mailboxId: string, at: OpScope): Promise<string[]> {
  return (await queryEmails(mailboxId, { limit: 500 }, at)).ids;
}

/** Alice's copy of the message with `subject`, once it is delivered. */
async function aliceReceived(subject: string): Promise<Record<string, unknown>> {
  const accountId = alice.accountId;
  for (let i = 0; i < 40; i++) {
    const res = await alice.request([
      ['Email/query', { accountId, filter: { subject } }, 'q'],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'sender', 'attachments', 'mailboxIds'],
        },
        'g',
      ],
    ]);
    const get = res.methodResponses.find((r) => r[2] === 'g')?.[1] as { list?: Record<string, unknown>[] } | undefined;
    const found = get?.list?.[0];
    if (found) return found;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`alice never received "${subject}"`);
}

async function aliceDownload(blobId: string): Promise<string> {
  const session = alice.currentSession!;
  const url = session.downloadUrl
    .replace('{accountId}', encodeURIComponent(alice.accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', 'a')
    .replace('{type}', encodeURIComponent('application/octet-stream'));
  const res = await fetch(url, { headers: { Authorization: alice.authHeaderFor(alice.connectionGen) } });
  expect(res.ok).toBe(true);
  return res.text();
}

describe.skipIf(!process.env.STALWART_IT_URL)('routed send on a live Stalwart', () => {
  beforeAll(async () => {
    await jmapClient.connect(URL, BOB, PASS);
    await alice.connect(URL, ALICE, PASS);
    base = opScope();
    bobId = base.accountId;
    teamId = accountIdNamed(jmapClient, TEAM) ?? '';
    expect(teamId, 'bob is not a member of team').toBeTruthy();
    teamScope = inAccount(base, teamId);
    const found = (await getIdentities(teamScope)).find((i) => i.email === TEAM);
    expect(found, "team's identity missing").toBeTruthy();
    teamIdentity = found!;
    const own = await resolveSendMailboxes(base);
    bobSent = own.sentId!;
    bobDrafts = own.draftsId!;
    teamSent = (await resolveSendMailboxes(teamScope)).sentId!;
    expect(bobSent && bobDrafts && teamSent).toBeTruthy();
  }, 60_000);

  it('lists your own account and the group, and not a folder-only share (E11)', async () => {
    const sendable = await getSendIdentities();
    expect(Object.keys(sendable)).toContain(bobId);
    expect(sendable[teamId]?.identities.map((i) => i.email)).toContain(TEAM);
    if (!FOLDER_SHARE) {
      console.warn('folder-only share not provisioned: the E11 half of this case is skipped');
      return;
    }
    const shareId = accountIdNamed(jmapClient, ALICE);
    expect(shareId, "alice's folder share is not in bob's session").toBeTruthy();
    // The share advertises submission, yet Identity/get is forbidden.
    expect(jmapClient.currentSession!.accounts[shareId!].accountCapabilities).toHaveProperty(
      'urn:ietf:params:jmap:submission',
    );
    expect(Object.keys(sendable)).not.toContain(shareId);
  }, 60_000);

  it("sends from team@ in team's account, with the attachment copied across (E1, Blob/copy)", async () => {
    const subject = `routed ${Date.now()}`;
    const body = `attachment from bob's account ${Math.random()}`;
    const blob = await uploadBytes(new TextEncoder().encode(body), 'text/plain', base);
    const bobSentBefore = await idsIn(bobSent, base);
    const bobDraftsBefore = await idsIn(bobDrafts, base);

    const result = await sendRouted({
      outgoing: {
        from: [{ email: TEAM }],
        to: [{ email: ALICE }],
        subject,
        textBody: 'sent as the team',
        attachments: [{ blobId: blob.blobId, type: 'text/plain', name: 'note.txt', size: blob.size }],
      },
      route: { jmapAccountId: teamId, identityId: teamIdentity.id },
      accountName: TEAM,
      blobAccountId: bobId,
      base,
    });
    expect(result.accountId).toBe(teamId);
    expect(result.filingWarning).toBeUndefined();

    const [filed] = await getFullEmails([result.emailId!], teamScope);
    expect(filed.mailboxIds[teamSent]).toBe(true);
    expect(filed.keywords.$draft).toBeUndefined();

    expect(await idsIn(bobSent, base)).toEqual(bobSentBefore);
    expect(await idsIn(bobDrafts, base)).toEqual(bobDraftsBefore);

    const got = await aliceReceived(subject);
    expect((got.from as { email: string }[])[0].email).toBe(TEAM);
    const attachments = got.attachments as { blobId: string; name: string }[];
    expect(attachments.map((a) => a.name)).toEqual(['note.txt']);
    expect(await aliceDownload(attachments[0].blobId)).toBe(body);
  }, 90_000);

  it("refuses your own account's team@ identity id in the group account, creating nothing (E4)", async () => {
    const ownTeam = (await getIdentities(base)).find((i) => i.email === TEAM);
    expect(ownTeam, "bob's own team@ identity missing").toBeTruthy();
    // Ids collide across accounts; this case means something only when the
    // own id names nothing in team's account.
    const teamIds = (await getIdentities(teamScope)).map((i) => i.id);
    expect(teamIds).not.toContain(ownTeam!.id);
    const before = await allEmailIds(teamScope);

    const err = await sendRouted({
      outgoing: { from: [{ email: TEAM }], to: [{ email: ALICE }], subject: `own id ${Date.now()}`, textBody: 'x' },
      route: { jmapAccountId: teamId, identityId: ownTeam!.id },
      accountName: TEAM,
      blobAccountId: bobId,
      base,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutedSendError);
    expect((err as RoutedSendError).reason).toBe('identity_gone');
    expect(await allEmailIds(teamScope)).toEqual(before);
  }, 60_000);

  it("refuses From bob@ with team's identity, which the server would accept (E5)", async () => {
    const before = await allEmailIds(teamScope);
    const err = await sendRouted({
      outgoing: { from: [{ email: BOB }], to: [{ email: ALICE }], subject: `wrong from ${Date.now()}`, textBody: 'x' },
      route: { jmapAccountId: teamId, identityId: teamIdentity.id },
      accountName: TEAM,
      blobAccountId: bobId,
      base,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoutedSendError);
    expect((err as RoutedSendError).reason).toBe('identity_gone');
    expect(await allEmailIds(teamScope)).toEqual(before);
  }, 60_000);

  it("destroys the draft from bob's own Drafts in his account only", async () => {
    const subject = `draft routed ${Date.now()}`;
    const draftId = await createDraft(
      { from: [{ email: TEAM }], to: [{ email: ALICE }], subject, textBody: 'from a draft' },
      bobDrafts,
      undefined,
      base,
    );
    // Email ids collide across accounts: whatever team holds, including a
    // message with the draft's own id, must survive the destroy.
    const teamBefore = await allEmailIds(teamScope);

    const result = await sendRouted({
      outgoing: { from: [{ email: TEAM }], to: [{ email: ALICE }], subject, textBody: 'from a draft' },
      route: { jmapAccountId: teamId, identityId: teamIdentity.id },
      accountName: TEAM,
      blobAccountId: bobId,
      draftId,
      draftAccountId: bobId,
      base,
    });
    expect(result.filingWarning).toBeUndefined();

    const { notFound } = await getFullEmailsWithState([draftId], base);
    expect(notFound).toEqual([draftId]);
    const teamAfter = await allEmailIds(teamScope);
    expect(teamAfter).toEqual(expect.arrayContaining(teamBefore));
    expect(teamAfter).toContain(result.emailId);
    console.info(
      `draft ${draftId} (bob) destroyed; team kept ${teamBefore.length} message(s)` +
        (teamBefore.includes(draftId) ? `, including its own ${draftId}` : ''),
    );
    await aliceReceived(subject);
  }, 90_000);
});

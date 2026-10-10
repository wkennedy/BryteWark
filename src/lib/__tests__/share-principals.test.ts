import { describe, it, expect } from 'vitest';
import { principalsListUsable, shareCandidatesEmptyReason } from '../share-principals';

describe('principalsListUsable', () => {
  const opened = { appAccountId: 'app-a', gen: 3 };

  it('holds while the same account is shown on the same connection, served by the client', () => {
    expect(principalsListUsable(opened, { appAccountId: 'app-a', gen: 3, served: true })).toBe(true);
  });

  it('fails while the client still serves another account (the switch window)', () => {
    expect(principalsListUsable(opened, { appAccountId: 'app-a', gen: 3, served: false })).toBe(false);
  });

  it('fails once another account is shown', () => {
    expect(principalsListUsable(opened, { appAccountId: 'app-b', gen: 3, served: true })).toBe(false);
  });

  it('fails once the connection was replaced', () => {
    expect(principalsListUsable(opened, { appAccountId: 'app-a', gen: 4, served: true })).toBe(false);
  });
});

describe('shareCandidatesEmptyReason', () => {
  const p = (id: string) => ({ id });
  it('says the server lists nobody, nobody but you, or nobody matching', () => {
    expect(shareCandidatesEmptyReason([], 'me')).toBe('none');
    // The device check: the server lists only your own principal.
    expect(shareCandidatesEmptyReason([p('me')], 'me')).toBe('only_self');
    expect(shareCandidatesEmptyReason([p('me'), p('ann')], 'me')).toBe('no_matches');
    expect(shareCandidatesEmptyReason([p('ann')], null)).toBe('no_matches');
  });
});

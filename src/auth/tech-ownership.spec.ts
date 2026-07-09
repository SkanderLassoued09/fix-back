import { normalizeIdentity, techIdentityMatches } from './tech-ownership';

describe('tech-ownership helper', () => {
  describe('normalizeIdentity', () => {
    it('trims strings', () => {
      expect(normalizeIdentity('  abc  ')).toBe('abc');
    });
    it('maps null/undefined/empty to empty string', () => {
      expect(normalizeIdentity(null)).toBe('');
      expect(normalizeIdentity(undefined)).toBe('');
      expect(normalizeIdentity('')).toBe('');
    });
    it('reads _id / username from an object shape', () => {
      expect(normalizeIdentity({ _id: 'X1' })).toBe('X1');
      expect(normalizeIdentity({ username: 'bob' })).toBe('bob');
    });
    it('stringifies non-strings (e.g. ObjectId-like)', () => {
      expect(normalizeIdentity({ toString: () => 'hex123' } as any)).toBe(
        'hex123',
      );
    });
  });

  describe('techIdentityMatches', () => {
    const user = { _id: 'U1', username: 'alice', role: 'ADMIN_TECH' };

    it('matches when assignee equals the user _id', () => {
      expect(techIdentityMatches('U1', user)).toBe(true);
    });

    it('matches when assignee equals the user username (legacy data)', () => {
      expect(techIdentityMatches('alice', user)).toBe(true);
    });

    it('matches despite surrounding whitespace', () => {
      expect(techIdentityMatches('  U1 ', user)).toBe(true);
    });

    it('does NOT match another technician', () => {
      expect(techIdentityMatches('U2', user)).toBe(false);
      expect(techIdentityMatches('bob', user)).toBe(false);
    });

    it('never matches an empty / unassigned value', () => {
      expect(techIdentityMatches('', user)).toBe(false);
      expect(techIdentityMatches(null, user)).toBe(false);
      expect(techIdentityMatches(undefined, user)).toBe(false);
    });

    it('never matches when there is no user', () => {
      expect(techIdentityMatches('U1', undefined)).toBe(false);
      expect(techIdentityMatches('U1', null)).toBe(false);
    });
  });
});

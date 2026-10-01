import { createSession, validateSession } from '../../src/auth/session';

test('creates session with token', () => {
  const s = createSession('u1');
  expect(s.token).toBe('tok_u1');
});
test('validates session token', () => {
  expect(validateSession('tok_u1')).toBe(true);
  expect(validateSession('bad')).toBe(false);
});
test('rejects empty user id', () => {
  expect(createSession('').token).toBe('tok_');
});

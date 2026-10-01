import { deactivate, findByEmail } from '../../src/users/service';

test('deactivates user', () => {
  expect(deactivate({ id: '1', email: 'a@b.c', active: true }).active).toBe(false);
});
test('finds user by email', () => {
  const users = [{ id: '1', email: 'a@b.c', active: true }];
  expect(findByEmail(users, 'a@b.c')?.id).toBe('1');
});
test('returns undefined for unknown email', () => {
  expect(findByEmail([], 'x@y.z')).toBeUndefined();
});

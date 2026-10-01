import { notify, notifyAll } from '../../src/notifications/notifier';

test('notifies a single user', () => {
  expect(notify('u1', 'hi')).toBe('[to:u1] hi');
});
test('notifies all users', () => {
  expect(notifyAll(['u1', 'u2'], 'hi')).toHaveLength(2);
});
test('empty user list yields no notifications', () => {
  expect(notifyAll([], 'hi')).toEqual([]);
});

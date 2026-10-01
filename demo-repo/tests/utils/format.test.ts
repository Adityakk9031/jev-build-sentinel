import { formatSubject, formatBody } from '../../src/utils/format';

test('trims subject', () => {
  expect(formatSubject('  hi  ')).toBe('hi');
});
test('collapses body whitespace', () => {
  expect(formatBody('a\n\n  b')).toBe('a b');
});
test('handles empty strings', () => {
  expect(formatSubject('')).toBe('');
});

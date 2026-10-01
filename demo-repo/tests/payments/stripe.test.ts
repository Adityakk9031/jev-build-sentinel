import { computeTotal, refund } from '../../src/payments/stripe';

test('computes total with tax', () => {
  expect(computeTotal([{ price: 100, qty: 2 }])).toBeCloseTo(216);
});
test('empty cart totals zero', () => {
  expect(computeTotal([])).toBe(0);
});
test('refund returns refunded status', () => {
  expect(refund('c1').status).toBe('refunded');
});
test('total is rounded to cents', () => {
  expect(computeTotal([{ price: 10.555, qty: 1 }])).toBe(11.4);
});

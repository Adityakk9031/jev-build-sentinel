const TAX_RATE = 0.08;

export function computeTotal(items: Array<{ price: number; qty: number }>): number {
  const subtotal = items.reduce((acc, i) => acc + i.price * i.qty, 0);
  return Math.round(subtotal * (1 + TAX_RATE) * 100) / 100;
}

export function refund(chargeId: string): { charge: string; status: string } {
  return { charge: chargeId, status: 'refunded' };
}

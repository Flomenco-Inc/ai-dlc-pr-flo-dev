// Simulation fixture: a checked discount. Not product code.
export function applyDiscount(price, percent) {
  if (!Number.isFinite(price) || price < 0) throw new Error('invalid price');
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('invalid percent');
  }
  return Math.round(price * (100 - percent)) / 100;
}

// simulation touch so the linked pull request is reviewed

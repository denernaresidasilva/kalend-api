export function nextPeriod(start: Date, interval: 'MONTHLY' | 'YEARLY'): Date {
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  if (interval === 'YEARLY') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

/** Normalize Brazilian national numbers and accept already international E.164 values. */
export function normalizeBrazilianPhone(value?: string): string | undefined {
  if (!value || value.length > 40) return undefined;
  const trimmed = value.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits || digits.startsWith('5555')) return undefined;

  if (hadPlus) {
    if (!/^[1-9]\d{7,14}$/.test(digits)) return undefined;
    return `+${digits}`;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13))
    return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return undefined;
}

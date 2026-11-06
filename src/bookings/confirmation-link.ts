import type { Prisma } from '@prisma/client';
export function confirmationLink(variables: Prisma.JsonValue): string | null {
  if (
    !variables ||
    typeof variables !== 'object' ||
    Array.isArray(variables) ||
    typeof variables.url_confirmacao !== 'string'
  )
    return null;
  try {
    const u = new URL(variables.url_confirmacao),
      token = u.searchParams.get('token');
    if (
      u.protocol !== 'https:' ||
      u.pathname !== '/confirmar-agendamento' ||
      u.hash ||
      !token ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      [...u.searchParams.keys()].some((k) => k !== 'token')
    )
      return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}
export function operationalPushPath(value: unknown): string | null {
  return typeof value === 'string' &&
    (/^\/confirmar-agendamento\?token=[A-Za-z0-9_-]{43}$/.test(value) ||
      /^\/agendar\/[a-z0-9-]{1,100}\?opportunity=[a-f0-9-]{36}$/i.test(value))
    ? value
    : null;
}

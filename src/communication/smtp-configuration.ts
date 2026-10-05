import { BadRequestException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { object, string } from '../common/validation.js';
import { email } from './contracts.js';
import type { Variables } from './contracts.js';

export const SMTP_PROVIDERS = {
  GOOGLE: 'smtp.gmail.com',
  MICROSOFT: 'smtp-mail.outlook.com',
  ICLOUD: 'smtp.mail.me.com',
  CUSTOM: '',
} as const;
export function normalizeSmtp(input: unknown): Variables {
  const d = object(input, [
    'host',
    'port',
    'secure',
    'username',
    'fromName',
    'fromEmail',
    'replyTo',
    'emailProvider',
  ]);
  const host = string(d.host, 'host', 253).toLowerCase();
  const port =
    typeof d.port === 'number'
      ? String(d.port)
      : String(Number(string(d.port, 'port')));
  const secure =
    typeof d.secure === 'boolean'
      ? String(d.secure)
      : string(d.secure, 'secure').toLowerCase();
  if (!(
    (port === '587' && secure === 'false') ||
    (port === '465' && secure === 'true')
  ))
    throw new BadRequestException('SMTP_TLS_REQUIRED');
  const provider =
    d.emailProvider === undefined
      ? (Object.entries(SMTP_PROVIDERS).find(
          ([, value]) => value === host,
        )?.[0] ?? 'CUSTOM')
      : string(d.emailProvider, 'emailProvider').toUpperCase();
  if (!Object.hasOwn(SMTP_PROVIDERS, provider))
    throw new BadRequestException('EMAIL_PROVIDER_INVALID');
  const c: Variables = {
    host,
    port,
    secure,
    username: string(d.username, 'username', 500),
    fromName: string(d.fromName, 'fromName', 500),
    fromEmail: email(d.fromEmail),
    emailProvider: provider,
  };
  if (/[\r\n]/.test(c.fromName + c.username))
    throw new BadRequestException('HEADER_INVALID');
  if (d.replyTo !== undefined && d.replyTo !== '') c.replyTo = email(d.replyTo);
  return c;
}
// Provider selection is a UI label; changing it alone does not change SMTP delivery.
export function sameSmtp(left: Variables, right: Variables) {
  const { emailProvider: _left, ...a } = left;
  const { emailProvider: _right, ...b } = right;
  return isDeepStrictEqual(a, b);
}
export function smtpTestData(
  sent: boolean,
  recipient: string,
  code: string | null,
) {
  return {
    lastVerifiedAt: new Date(),
    lastTestRecipient: recipient,
    lastTestStatus: sent ? 'SUCCESS' : 'ERROR',
    status: sent ? ('CONNECTED' as const) : ('FAILED' as const),
    lastError: code,
    ...(!sent ? { enabled: false } : {}),
  };
}

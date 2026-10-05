import { BadRequestException } from '@nestjs/common';
import { object, string } from '../common/validation.js';
export const EVENTS = [
  'OWNER_WELCOME',
  'TRIAL_STARTED',
  'TRIAL_EXPIRING',
  'TRIAL_EXPIRED',
  'PAYMENT_PENDING',
  'PAYMENT_APPROVED',
  'PAYMENT_FAILED',
  'PAYMENT_OVERDUE',
  'SUBSCRIPTION_GRACE_PERIOD',
  'SUBSCRIPTION_SUSPENDED',
  'SUBSCRIPTION_REACTIVATED',
  'SUBSCRIPTION_CANCELLED',
  'SECURITY_PASSWORD_CHANGED',
] as const;
export type Event = (typeof EVENTS)[number];
export type Channel = 'EMAIL' | 'WHATSAPP' | 'PUSH';
export type Provider = 'SMTP' | 'GMAIL' | 'META' | 'EVOLUTION' | 'PUSH_PENDING';
export type Variables = Record<string, string>;
export const channels: Record<Provider, Channel> = {
  SMTP: 'EMAIL',
  GMAIL: 'EMAIL',
  META: 'WHATSAPP',
  EVOLUTION: 'WHATSAPP',
  PUSH_PENDING: 'PUSH',
};
export function eventName(v: unknown): Event {
  if (!EVENTS.includes(v as Event))
    throw new BadRequestException('COMMUNICATION_EVENT_INVALID');
  return v as Event;
}
export function providerName(v: string): Provider {
  if (!Object.hasOwn(channels, v))
    throw new BadRequestException('COMMUNICATION_PROVIDER_INVALID');
  return v as Provider;
}
export function variablesFor(event: Event): string[] {
  if (event === 'SECURITY_PASSWORD_CHANGED') return ['nome'];
  return [
    'nome',
    'empresa',
    ...(event.startsWith('TRIAL_')
      ? ['plano', 'dias_trial', 'vencimento']
      : []),
    ...(event.startsWith('PAYMENT_') ? ['valor'] : []),
  ];
}
export function email(v: unknown) {
  const s = string(v, 'email', 254).toLowerCase();
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(
      s,
    )
  )
    throw new BadRequestException('RECIPIENT_INVALID');
  return s;
}
export function phone(v: unknown) {
  const s = string(v, 'phone', 32).replace(/[ ()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(s))
    throw new BadRequestException('RECIPIENT_INVALID');
  return s;
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
export function renderText(source: string, event: Event, values: Variables) {
  const allow = variablesFor(event);
  const result = source.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
    if (
      !allow.includes(key) ||
      !Object.hasOwn(values, key) ||
      typeof values[key] !== 'string' ||
      values[key].length > 2048
    )
      throw new BadRequestException('TEMPLATE_VARIABLE_INVALID');
    return values[key];
  });
  // Check syntax in source, not substituted values (values are never evaluated recursively).
  if (/[{}]/.test(source.replace(/\{\{([a-z_]+)\}\}/g, '')))
    throw new BadRequestException('TEMPLATE_SYNTAX_INVALID');
  if (result.length > 16000)
    throw new BadRequestException('TEMPLATE_OUTPUT_TOO_LARGE');
  return result;
}
export type Message = {
  globalRecipientUserId?: string;
  to: string;
  subject?: string;
  text: string;
  html?: string;
  title?: string;
  // Internal authorization context, never included in the browser payload.
  pushRecipient?: {
    userId: string;
    environment: 'SANDBOX' | 'PRODUCTION';
    companyId?: string;
    audience: 'COMPANY' | 'ACCOUNT' | 'ADMIN_TEST';
  };
  meta?: { id: string; name: string; language: string; parameters: string[] };
};
export function templateContent(
  input: unknown,
  channel: Channel,
  event: Event,
  provider?: Provider,
) {
  if (provider === 'META') {
    const d = object(input, ['id', 'name', 'language', 'parameters']);
    const id = string(d.id, 'id', 100),
      name = string(d.name, 'name', 512),
      language = string(d.language, 'language', 20);
    if (
      !/^\d+$/.test(id) ||
      !/^[a-z0-9_]+$/.test(name) ||
      !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) ||
      !Array.isArray(d.parameters) ||
      d.parameters.length > 20 ||
      d.parameters.some(
        (k) => typeof k !== 'string' || !variablesFor(event).includes(k),
      )
    )
      throw new BadRequestException('META_TEMPLATE_INVALID');
    return {
      text: '',
      metaId: id,
      metaName: name,
      metaLanguage: language,
      metaParameters: JSON.stringify(d.parameters),
    };
  }
  const d = object(
    input,
    channel === 'EMAIL'
      ? ['subject', 'text']
      : channel === 'PUSH'
        ? ['title', 'text']
        : ['text'],
  );
  const result: Variables = { text: string(d.text, 'text', 8000) };
  if (channel === 'EMAIL') result.subject = string(d.subject, 'subject', 200);
  if (channel === 'PUSH') result.title = string(d.title, 'title', 200);
  for (const value of Object.values(result))
    renderText(
      value,
      event,
      Object.fromEntries(variablesFor(event).map((k) => [k, 'example'])),
    );
  if (/[\r\n]/.test(result.subject ?? result.title ?? ''))
    throw new BadRequestException('HEADER_INVALID');
  return result;
}
export function render(
  content: Variables,
  channel: Channel,
  event: Event,
  values: Variables,
  to: string,
): Message {
  if (content.metaId) {
    const keys = JSON.parse(content.metaParameters) as string[];
    return {
      to,
      text: '',
      meta: {
        id: content.metaId,
        name: content.metaName,
        language: content.metaLanguage,
        parameters: keys.map((k) => renderText('{{' + k + '}}', event, values)),
      },
    };
  }
  const text = renderText(content.text, event, values);
  const subject = content.subject
    ? renderText(content.subject, event, values)
    : undefined;
  const title = content.title
    ? renderText(content.title, event, values)
    : undefined;
  if (/[\r\n]/.test(subject ?? title ?? ''))
    throw new BadRequestException('HEADER_INVALID');
  // HTML is generated from escaped text. No administrative HTML/attributes/URLs execute.
  return {
    to,
    text,
    subject,
    title,
    ...(channel === 'EMAIL'
      ? { html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` }
      : {}),
  };
}
export type FailureKind =
  | 'TRANSIENT'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'PERMANENT'
  | 'UNCERTAIN'
  | 'TEMPLATE'
  | 'RECIPIENT';
export class TransportFailure extends Error {
  constructor(readonly kind: FailureKind) {
    super(`COMMUNICATION_${kind}`);
  }
}
export function retry(kind: FailureKind, attempts: number, now = new Date()) {
  return (kind === 'TRANSIENT' || kind === 'RATE_LIMIT') && attempts < 5
    ? new Date(
        now.getTime() +
          Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1)) * 1000,
      )
    : null;
}
export interface Transport {
  verify(config: Variables, secrets: Variables): Promise<void>;
  send(
    config: Variables,
    secrets: Variables,
    message: Message,
  ): Promise<string>;
}

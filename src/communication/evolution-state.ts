import type { EvolutionConnection } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { SecretVault } from '../billing/secret-vault.js';
import { evolutionQr, record } from './evolution-client.js';

// Display policy, not a promise about WhatsApp's remote validity.
export const QR_TTL_MS = 60000;
export const PAIRING_TTL_MS = 120000;
export const ATTEMPT_TTL_MS = 300000;
export const CODE_WAIT_MS = 60000;
export const CLEAR_ATTEMPT = {
  connectionRequested: false,
  codeEncrypted: null,
  codeFingerprint: null,
  codeExpiresAt: null,
  pairingPhoneEncrypted: null,
  attemptExpiresAt: null,
} as const;

export const evolutionMessages: Record<string, string> = {
  EVOLUTION_AUTH_FAILED:
    'A credencial da integração precisa ser verificada pela administração.',
  EVOLUTION_FORBIDDEN: 'A Evolution recusou a autorização da integração.',
  EVOLUTION_UNAVAILABLE:
    'A Evolution está temporariamente indisponível. Tente novamente.',
  EVOLUTION_TIMEOUT:
    'A Evolution não respondeu no prazo. Atualize o estado antes de tentar novamente.',
  EVOLUTION_RATE_LIMITED:
    'A Evolution limitou as solicitações. Aguarde antes de tentar novamente.',
  EVOLUTION_BAD_REQUEST:
    'A Evolution recusou a solicitação. A integração precisa ser verificada.',
  EVOLUTION_INVALID_RESPONSE: 'A Evolution retornou uma resposta inesperada.',
  CONNECTION_FAILED: 'A Evolution não conseguiu iniciar esta conexão.',
  CONNECTION_NOT_FOUND:
    'A instância não existe mais. Configure a conexão novamente.',
  INSTANCE_ALREADY_EXISTS:
    'A instância já existe. Atualize o estado da conexão.',
  INSTANCE_CREATION_FAILED:
    'Não foi possível preparar a instância de WhatsApp.',
  CONNECTION_NOT_OPEN:
    'O WhatsApp precisa estar conectado para enviar mensagens.',
  INTEGRATION_INTERNAL_ERROR:
    'Não foi possível atualizar a integração. Tente novamente.',
  INTEGRATION_STATE_UNAVAILABLE:
    'O estado da integração está temporariamente indisponível. Tente novamente.',
  INTEGRATION_BUSY:
    'Uma operação está em andamento. Aguarde antes de enviar a mensagem.',
  MESSAGE_ACCEPTANCE_UNKNOWN:
    'Não foi possível confirmar a aceitação da mensagem. Verifique o envio antes de tentar novamente.',
  EVOLUTION_WEBHOOK_BASE_URL_REQUIRED:
    'A URL pública do webhook precisa ser configurada pela administração.',
  EVOLUTION_WEBHOOK_BASE_URL_INVALID:
    'A URL pública do webhook precisa ser verificada pela administração.',
  EVOLUTION_ENVIRONMENT_MISMATCH:
    'O ambiente da integração precisa ser verificado pela administração.',
  QR_UNAVAILABLE: 'Aguardando o QR Code da Evolution.',
  PAIRING_CODE_UNAVAILABLE:
    'Aguardando o código de conexão. Você também pode usar o QR Code.',
  CODE_EXPIRED: 'Este código expirou. Solicite um novo código.',
  CONNECTION_TIMEOUT: 'A tentativa expirou. Solicite uma nova conexão.',
  WHATSAPP_LOGGED_OUT:
    'O WhatsApp encerrou ou revogou a sessão. Conecte novamente.',
  WHATSAPP_CONNECTION_CLOSED: 'A conexão com o WhatsApp foi encerrada.',
  OPERATION_IN_PROGRESS:
    'Uma operação está em andamento. O estado será atualizado automaticamente.',
};

export function savedCode(row: EvolutionConnection, vault: SecretVault) {
  if (
    !row.codeEncrypted ||
    !row.codeExpiresAt ||
    row.codeExpiresAt.getTime() <= Date.now()
  )
    return null;
  const raw = record(
    JSON.parse(vault.decrypt(row.codeEncrypted, `evolution:code:${row.id}`)),
  );
  return {
    qrCode: evolutionQr(raw.qrCode),
    pairingCode:
      typeof raw.pairingCode === 'string' &&
      /^[A-Za-z0-9-]{8,12}$/.test(raw.pairingCode)
        ? raw.pairingCode
        : null,
    mode: raw.mode === 'phone' ? 'phone' : 'qr',
  };
}

export function codePatch(
  row: EvolutionConnection,
  result: unknown,
  vault: SecretVault,
  receivedAt = new Date(),
) {
  const raw = record(result);
  const qr = record(raw.qrcode ?? result);
  const qrCode = evolutionQr(qr.base64);
  const pairingCode =
    typeof qr.pairingCode === 'string' &&
    /^[A-Za-z0-9-]{8,12}$/.test(qr.pairingCode)
      ? qr.pairingCode
      : null;
  const mode = row.pairingMethod === 'PHONE' && pairingCode ? 'phone' : 'qr';
  const identity = mode === 'phone' ? pairingCode : qrCode;
  if (!identity) return null;
  const key = vault.decrypt(row.webhookSecretEncrypted!, `evolution:${row.id}`);
  const fingerprint = `${mode}:${createHmac('sha256', key).update(identity).digest('hex')}`;
  const same = row.codeFingerprint === fingerprint && row.codeExpiresAt != null;
  // A retry/repeated GET/event never extends the same code's validity.
  const expiresAt = same
    ? row.codeExpiresAt!
    : new Date(
        receivedAt.getTime() + (mode === 'phone' ? PAIRING_TTL_MS : QR_TTL_MS),
      );
  return {
    codeEncrypted:
      expiresAt.getTime() > Date.now()
        ? vault.encrypt(
            JSON.stringify({
              qrCode: mode === 'qr' ? qrCode : null,
              pairingCode: mode === 'phone' ? pairingCode : null,
              mode,
            }),
            `evolution:code:${row.id}`,
          )
        : null,
    codeFingerprint: fingerprint,
    codeExpiresAt: expiresAt,
    lastQrAt: same ? row.lastQrAt : receivedAt,
    status: mode === 'qr' ? ('QR_AVAILABLE' as const) : ('CONNECTING' as const),
    lastError:
      expiresAt.getTime() <= Date.now()
        ? 'CODE_EXPIRED'
        : row.pairingMethod === 'PHONE' && mode === 'qr'
          ? 'PAIRING_CODE_UNAVAILABLE'
          : null,
  };
}

export function attemptTimedOut(row: EvolutionConnection, now = Date.now()) {
  return (
    row.connectionRequested &&
    ((row.attemptExpiresAt != null && row.attemptExpiresAt.getTime() <= now) ||
      (!row.codeFingerprint &&
        row.attemptStartedAt != null &&
        row.attemptStartedAt.getTime() + CODE_WAIT_MS <= now))
  );
}

import { Injectable } from '@nestjs/common';
import { secureRequest } from './secure-http.js';

export class EvolutionFailure extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function evolutionQr(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 200000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)
  )
    return null;
  return Buffer.from(value.split(',')[1], 'base64')
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? value
    : null;
}
export function evolutionPhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32)
    throw new EvolutionFailure('INVALID_PHONE');
  const normalized = value.trim().replace(/[ ()-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(normalized))
    throw new EvolutionFailure('INVALID_PHONE');
  return normalized.replace(/^\+/, '');
}
/** Evolution 2.3.7 contracts. Fixed origin; no caller-controlled URL or credentials. */
@Injectable()
export class EvolutionClient {
  private async request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const key = process.env.EVOLUTION_API_KEY;
    if (!key) throw new EvolutionFailure('EVOLUTION_AUTH_FAILED');
    try {
      const result = await secureRequest(
        new URL(path, 'https://evolution-api.kalend.tech'),
        method,
        { apikey: key, 'Content-Type': 'application/json' },
        body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
        262144,
      );
      if (result.status === 401 || result.status === 403)
        throw new EvolutionFailure('EVOLUTION_AUTH_FAILED');
      if (result.status === 404)
        throw new EvolutionFailure('CONNECTION_NOT_FOUND');
      if (result.status === 409)
        throw new EvolutionFailure('INSTANCE_ALREADY_EXISTS');
      if (result.status < 200 || result.status >= 300)
        throw new EvolutionFailure(
          result.status >= 500 || result.status === 429
            ? 'EVOLUTION_UNAVAILABLE'
            : 'CONNECTION_FAILED',
        );
      const parsed: unknown = JSON.parse(result.body.toString('utf8'));
      if (record(parsed).error === true)
        throw new EvolutionFailure('CONNECTION_FAILED');
      return parsed;
    } catch (error) {
      if (error instanceof EvolutionFailure) throw error;
      throw new EvolutionFailure('EVOLUTION_UNAVAILABLE');
    }
  }
  createInstance(instanceName: string) {
    return this.request('/instance/create', 'POST', {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
    });
  }
  async fetchInstances(instanceName: string) {
    let value: unknown;
    try {
      value = await this.request(
        `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
      );
    } catch (error) {
      if (
        error instanceof EvolutionFailure &&
        error.code === 'CONNECTION_NOT_FOUND'
      )
        return null;
      throw error;
    }
    if (!Array.isArray(value)) throw new EvolutionFailure('CONNECTION_FAILED');
    return (
      value
        .map(record)
        .find(
          (row) =>
            row.name === instanceName ||
            record(row.instance).instanceName === instanceName,
        ) ?? null
    );
  }
  connectInstance(name: string, number?: string) {
    return this.request(
      `/instance/connect/${encodeURIComponent(name)}${number ? `?number=${evolutionPhone(number)}` : ''}`,
    );
  }
  fetchQrCode(name: string) {
    return this.connectInstance(name);
  }
  fetchConnectionState(name: string) {
    return this.request(
      `/instance/connectionState/${encodeURIComponent(name)}`,
    );
  }
  restartInstance(name: string) {
    return this.request(
      `/instance/restart/${encodeURIComponent(name)}`,
      'POST',
    );
  }
  logoutInstance(name: string) {
    return this.request(
      `/instance/logout/${encodeURIComponent(name)}`,
      'DELETE',
    );
  }
  deleteInstance(name: string) {
    return this.request(
      `/instance/delete/${encodeURIComponent(name)}`,
      'DELETE',
    );
  }
  setWebhook(name: string, url: string, token: string) {
    return this.request(`/webhook/set/${encodeURIComponent(name)}`, 'POST', {
      webhook: {
        enabled: true,
        url,
        headers: { 'x-kalend-evolution-token': token },
        byEvents: false,
        base64: true,
        events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE'],
      },
    });
  }
  async sendTextMessage(name: string, number: string, text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000)
      throw new EvolutionFailure('INVALID_MESSAGE');
    const result = record(
      await this.request(
        `/message/sendText/${encodeURIComponent(name)}`,
        'POST',
        { number: evolutionPhone(number), text, linkPreview: false },
      ),
    );
    const id = record(result.key).id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new EvolutionFailure('MESSAGE_ACCEPTANCE_UNKNOWN');
    return { accepted: true, messageId: id };
  }
}

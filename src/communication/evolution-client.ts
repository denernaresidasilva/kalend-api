import { Injectable } from '@nestjs/common';
import { secureRequest } from './secure-http.js';
import { TransportFailure } from './contracts.js';

export class EvolutionFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly uncertain = false,
  ) {
    super(code);
  }
  get httpStatus() {
    if (this.code === 'INVALID_PHONE' || this.code === 'INVALID_MESSAGE')
      return 400;
    if (
      this.code === 'INSTANCE_ALREADY_EXISTS' ||
      this.code === 'CONNECTION_NOT_FOUND' ||
      this.code === 'CONNECTION_NOT_OPEN' ||
      this.code === 'INTEGRATION_BUSY'
    )
      return 409;
    if (this.code === 'EVOLUTION_RATE_LIMITED') return 429;
    if (this.code === 'EVOLUTION_TIMEOUT') return 504;
    if (this.code === 'EVOLUTION_UNAVAILABLE') return 503;
    if (this.code === 'INTEGRATION_STATE_UNAVAILABLE') return 503;
    return 502;
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
  const png = Buffer.from(value.split(',')[1], 'base64');
  if (
    png.length < 45 ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND'
  )
    return null;
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 4096 && height <= 4096
    ? value
    : null;
}
export function evolutionPhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32)
    throw new EvolutionFailure('INVALID_PHONE');
  const normalized = value.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(normalized))
    throw new EvolutionFailure('INVALID_PHONE');
  return normalized;
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
      if (result.status === 401)
        throw new EvolutionFailure('EVOLUTION_AUTH_FAILED', 401);
      if (result.status === 403)
        throw new EvolutionFailure('EVOLUTION_FORBIDDEN', 403);
      if (result.status === 404)
        throw new EvolutionFailure('CONNECTION_NOT_FOUND', 404);
      if (result.status === 409)
        throw new EvolutionFailure('INSTANCE_ALREADY_EXISTS', 409);
      if (result.status === 429)
        throw new EvolutionFailure('EVOLUTION_RATE_LIMITED', 429);
      if (result.status < 200 || result.status >= 300)
        throw new EvolutionFailure(
          result.status >= 500
            ? 'EVOLUTION_UNAVAILABLE'
            : 'EVOLUTION_BAD_REQUEST',
          result.status,
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body.toString('utf8'));
      } catch {
        throw new EvolutionFailure(
          'EVOLUTION_INVALID_RESPONSE',
          result.status,
          method === 'POST' && path.startsWith('/message/'),
        );
      }
      if (record(parsed).error === true)
        throw new EvolutionFailure('CONNECTION_FAILED');
      return parsed;
    } catch (error) {
      if (error instanceof EvolutionFailure) throw error;
      const uncertain =
        error instanceof TransportFailure && error.kind === 'UNCERTAIN';
      const timeout =
        error instanceof Error && error.name === 'HttpRequestTimeout';
      throw new EvolutionFailure(
        timeout ? 'EVOLUTION_TIMEOUT' : 'EVOLUTION_UNAVAILABLE',
        undefined,
        uncertain ||
          (timeout && method === 'POST' && path.startsWith('/message/')),
      );
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
    if (!Array.isArray(value))
      throw new EvolutionFailure('EVOLUTION_INVALID_RESPONSE');
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
      throw new EvolutionFailure('MESSAGE_ACCEPTANCE_UNKNOWN', undefined, true);
    return { accepted: true, messageId: id };
  }
}

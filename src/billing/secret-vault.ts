import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
@Injectable()
export class SecretVault {
  private key() {
    const encoded = process.env.GATEWAY_ENCRYPTION_KEY;
    if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded))
      throw new ServiceUnavailableException(
        'Chave de criptografia dos gateways indisponível.',
      );
    return Buffer.from(encoded, 'hex');
  }
  encrypt(value: string, scope: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(scope));
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }
  decrypt(value: string, scope: string) {
    try {
      const [version, iv, tag, data] = value.split('.');
      if (version !== 'v1') throw new Error();
      const cipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        Buffer.from(iv, 'base64'),
      );
      cipher.setAAD(Buffer.from(scope));
      cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        cipher.update(Buffer.from(data, 'base64')),
        cipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Credencial indisponível.');
    }
  }
}

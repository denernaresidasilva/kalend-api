import { credentialHash } from '../auth/auth.tokens.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretVault } from '../billing/secret-vault.js';
import { email, TransportFailure } from './contracts.js';
import type { Message, Transport, Variables } from './contracts.js';
import type { AuthIdentity } from '../auth/auth.types.js';
import { GoogleApi, GMAIL_SCOPE, GOOGLE_EMAIL_SCOPE } from './google-api.js';

const scope = (environment: string) =>
  `communication:GLOBAL:GMAIL:${environment}:credentials`;
export const oauthHash = (s: string) =>
  createHash('sha256').update(s).digest('hex');
export const GMAIL_COOKIE = '__Host-kalend_gmail_oauth';
export function gmailRedirectUri() {
  try {
    const url = new URL(process.env.COMMUNICATION_GMAIL_CALLBACK_URL ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/communication/gmail/callback'
    )
      throw new Error();
    return url.href;
  } catch {
    throw new ServiceUnavailableException('GMAIL_CALLBACK_NOT_CONFIGURED');
  }
}
@Injectable()
export class GmailTransport implements Transport {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(GoogleApi) private readonly google: GoogleApi,
  ) {}
  private async context() {
    const row = await this.db.globalCommunicationProvider.findUnique({
      where: { provider: 'GMAIL' },
    });
    if (!row?.credentialsEncrypted || row.scope !== 'GLOBAL')
      throw new TransportFailure('AUTH');
    const secret = JSON.parse(
      this.vault.decrypt(row.credentialsEncrypted, scope(row.environment)),
    ) as Variables;
    const config = row.config as Variables;
    if (!config.clientId || !secret.clientSecret)
      throw new TransportFailure('AUTH');
    return { row, secret, config };
  }
  async connect(identity: AuthIdentity) {
    const ctx = await this.context();
    const redirectUri = gmailRedirectUri();
    const state = randomBytes(32).toString('base64url'),
      binding = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    await this.db.globalGmailOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.db.globalGmailOAuthState.create({
      data: {
        stateHash: oauthHash(state),
        bindingHash: oauthHash(binding),
        codeVerifierEncrypted: this.vault.encrypt(
          verifier,
          `communication:GLOBAL:GMAIL:state:${oauthHash(state)}`,
        ),
        actorId: identity.user.id,
        sessionId: identity.session.id,
        configurationRevision: ctx.row.revision,
        redirectUri,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: ctx.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `${GMAIL_SCOPE} ${GOOGLE_EMAIL_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return { authorizationUrl: url.href, binding };
  }
  async callback(
    state: unknown,
    code: unknown,
    binding: string | undefined,
    denied = false,
  ) {
    if (
      typeof state !== 'string' ||
      !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
      !binding ||
      !/^[a-zA-Z0-9_-]{43}$/.test(binding)
    )
      throw new BadRequestException('GMAIL_STATE_INVALID');
    const stateHash = oauthHash(state),
      now = new Date();
    const saved = await this.db.globalGmailOAuthState.findUnique({
      where: { stateHash },
    });
    if (
      !saved ||
      saved.bindingHash !== oauthHash(binding) ||
      saved.usedAt ||
      saved.expiresAt <= now
    )
      throw new BadRequestException('GMAIL_STATE_INVALID');
    const session = await this.db.authSession.findFirst({
      where: {
        id: saved.sessionId,
        userId: saved.actorId,
        revokedAt: null,
        expiresAt: { gt: now },
        refreshExpiresAt: { gt: now },
        user: { isActive: true, isSuperAdmin: true },
      },
      include: { user: { select: { passwordHash: true } } },
    });
    if (
      !session ||
      session.credentialHash !== credentialHash(session.user.passwordHash)
    )
      throw new BadRequestException('GMAIL_STATE_INVALID');
    const consumed = await this.db.globalGmailOAuthState.updateMany({
      where: {
        stateHash,
        bindingHash: saved.bindingHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (consumed.count !== 1)
      throw new BadRequestException('GMAIL_STATE_INVALID');
    if (denied) return { connected: false };
    if (
      typeof code !== 'string' ||
      !code ||
      code.length > 4096 ||
      /[\r\n]/.test(code)
    )
      throw new BadRequestException('GMAIL_CODE_INVALID');
    const ctx = await this.context();
    if (
      ctx.row.revision !== saved.configurationRevision ||
      saved.redirectUri !== gmailRedirectUri()
    )
      throw new ConflictException('CONFIGURATION_CHANGED');
    try {
      const verifier = this.vault.decrypt(
        saved.codeVerifierEncrypted,
        `communication:GLOBAL:GMAIL:state:${stateHash}`,
      );
      const tokens = await this.google.token({
        code,
        code_verifier: verifier,
        client_id: ctx.config.clientId,
        client_secret: ctx.secret.clientSecret,
        redirect_uri: saved.redirectUri,
        grant_type: 'authorization_code',
      });
      if (
        !tokens.refreshToken ||
        !tokens.scope.split(' ').includes(GMAIL_SCOPE)
      )
        throw new TransportFailure('AUTH');
      const accountEmail = await this.google.account(tokens.accessToken);
      if (accountEmail !== email(ctx.config.fromEmail))
        throw new TransportFailure('AUTH');
      const encrypted = this.vault.encrypt(
        JSON.stringify({
          clientSecret: ctx.secret.clientSecret,
          ...tokens,
          accountEmail,
        }),
        scope(ctx.row.environment),
      );
      await this.db.$transaction(async (tx) => {
        const session = await tx.authSession.findFirst({
          where: {
            id: saved.sessionId,
            userId: saved.actorId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
            refreshExpiresAt: { gt: new Date() },
            user: { isActive: true, isSuperAdmin: true },
          },
          include: { user: { select: { passwordHash: true } } },
        });
        if (
          !session ||
          session.credentialHash !== credentialHash(session.user.passwordHash)
        )
          throw new ConflictException('GMAIL_STATE_INVALID');
        const result = await tx.globalCommunicationProvider.updateMany({
          where: { provider: 'GMAIL', revision: saved.configurationRevision },
          data: {
            credentialsEncrypted: encrypted,
            status: 'CONNECTED',
            enabled: false,
            lastError: null,
            lastVerifiedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (!result.count) throw new ConflictException('CONFIGURATION_CHANGED');
        await tx.globalCommunicationLog.create({
          data: { actorId: saved.actorId, action: 'GMAIL_CONNECTED' },
        });
      });
      return { connected: true };
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw new ServiceUnavailableException('GMAIL_CONNECT_FAILED');
    }
  }
  async disconnect(actorId: string) {
    const ctx = await this.context();
    // Commit local removal before calling Google; a network outage must never keep local sends enabled.
    await this.db.$transaction(async (tx) => {
      const result = await tx.globalCommunicationProvider.updateMany({
        where: { provider: 'GMAIL', revision: ctx.row.revision },
        data: {
          credentialsEncrypted: this.vault.encrypt(
            JSON.stringify({ clientSecret: ctx.secret.clientSecret }),
            scope(ctx.row.environment),
          ),
          enabled: false,
          status: 'PENDING_VALIDATION',
          lastVerifiedAt: null,
          lastError: null,
          revision: { increment: 1 },
        },
      });
      if (!result.count) throw new ConflictException('CONFIGURATION_CHANGED');
      await tx.globalGmailOAuthState.deleteMany({});
      await tx.globalCommunicationLog.create({
        data: { actorId, action: 'GMAIL_DISCONNECTED' },
      });
    });
    let remoteRevoked = !ctx.secret.refreshToken;
    if (ctx.secret.refreshToken) {
      try {
        await this.google.revoke(ctx.secret.refreshToken);
        remoteRevoked = true;
      } catch {
        /* no secrets or remote body in logs */
      }
    }
    return { disconnected: true, remoteRevoked };
  }
  async status() {
    try {
      const ctx = await this.context();
      return {
        configured: true,
        connected: !!ctx.secret.refreshToken && ctx.row.status === 'CONNECTED',
        accountEmail: ctx.secret.refreshToken
          ? (ctx.secret.accountEmail ?? null)
          : null,
        reconnectRequired: ctx.row.lastError === 'GMAIL_RECONNECT_REQUIRED',
      };
    } catch {
      return {
        configured: false,
        connected: false,
        accountEmail: null,
        reconnectRequired: false,
      };
    }
  }
  private async invalidate(
    ctx: Awaited<ReturnType<GmailTransport['context']>>,
  ) {
    await this.db.globalCommunicationProvider.updateMany({
      where: {
        provider: 'GMAIL',
        revision: ctx.row.revision,
        credentialsEncrypted: ctx.row.credentialsEncrypted,
      },
      data: {
        enabled: false,
        status: 'FAILED',
        lastError: 'GMAIL_RECONNECT_REQUIRED',
        credentialsEncrypted: this.vault.encrypt(
          JSON.stringify({ clientSecret: ctx.secret.clientSecret }),
          scope(ctx.row.environment),
        ),
        revision: { increment: 1 },
      },
    });
  }
  private async access(c: Variables, s: Variables) {
    const ctx = await this.context();
    if (
      ctx.config.clientId !== c.clientId ||
      ctx.config.fromEmail !== c.fromEmail ||
      ctx.secret.clientSecret !== s.clientSecret ||
      ctx.secret.refreshToken !== s.refreshToken ||
      !ctx.secret.refreshToken
    )
      throw new TransportFailure('AUTH');
    if (
      Number(ctx.secret.expiresAt) > Date.now() + 60000 &&
      ctx.secret.accessToken
    )
      return { token: ctx.secret.accessToken, ctx };
    try {
      const tokens = await this.google.token({
        client_id: ctx.config.clientId,
        client_secret: ctx.secret.clientSecret,
        refresh_token: ctx.secret.refreshToken,
        grant_type: 'refresh_token',
      });
      if (tokens.scope && !tokens.scope.split(' ').includes(GMAIL_SCOPE))
        throw new TransportFailure('AUTH');
      const encrypted = this.vault.encrypt(
        JSON.stringify({
          ...ctx.secret,
          ...tokens,
          scope: tokens.scope || ctx.secret.scope,
        }),
        scope(ctx.row.environment),
      );
      const result = await this.db.globalCommunicationProvider.updateMany({
        where: {
          provider: 'GMAIL',
          revision: ctx.row.revision,
          credentialsEncrypted: ctx.row.credentialsEncrypted,
        },
        data: {
          credentialsEncrypted: encrypted,
        },
      });
      if (!result.count) throw new TransportFailure('TRANSIENT');
      // Use new ciphertext for conditional invalidation after an API authorization failure.
      ctx.row.credentialsEncrypted = encrypted;
      return { token: tokens.accessToken, ctx };
    } catch (e) {
      if (e instanceof TransportFailure && e.kind === 'AUTH')
        await this.invalidate(ctx);
      throw e;
    }
  }
  async verify(c: Variables, s: Variables) {
    const { token, ctx } = await this.access(c, s);
    try {
      if ((await this.google.account(token)) !== email(c.fromEmail))
        throw new TransportFailure('AUTH');
    } catch (e) {
      if (e instanceof TransportFailure && e.kind === 'AUTH')
        await this.invalidate(ctx);
      throw e;
    }
  }
  async send(c: Variables, s: Variables, m: Message) {
    if (!m.subject || /[\r\n]/.test(m.subject) || m.subject.length > 200)
      throw new TransportFailure('PERMANENT');
    const from = email(c.fromEmail),
      to = email(m.to);
    const raw = await new MailComposer({
      from,
      to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
      .compile()
      .build();
    const { token, ctx } = await this.access(c, s);
    try {
      return await this.google.send(token, raw.toString('base64url'));
    } catch (e) {
      if (e instanceof TransportFailure && e.kind === 'AUTH')
        await this.invalidate(ctx);
      throw e;
    }
  }
}

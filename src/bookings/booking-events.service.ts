import { ForbiddenException, HttpException, Inject, Injectable, Logger, type MessageEvent, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { Observable, concatMap, filter, finalize, fromEvent, map, merge, takeUntil, timer } from 'rxjs';
import { AuthService } from '../auth/auth.service.js';
import { ACCESS_COOKIE } from '../auth/auth.config.js';
import { readCookie } from '../auth/auth.http.js';
import type { AuthRequest } from '../auth/auth.types.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Change = { companyId: string; professionalIds: string[] };
const channel = 'kalend_booking_events';
const uuid = /^[0-9a-f-]{36}$/i;

@Injectable()
export class BookingEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly events = new EventEmitter();
  private readonly connections = new Map<string, number>();
  private readonly logger = new Logger(BookingEventsService.name);
  private client?: pg.Client;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) { this.events.setMaxListeners(0); }

  async onModuleInit() { await this.connect(); }
  private async connect() {
    if (this.stopped || !process.env.DATABASE_URL) return;
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, application_name: 'kalend-booking-events' });
    this.client = client;
    let failed = false;
    const retry = () => {
      if (failed) return; failed = true;
      void client.end().catch(() => {});
      if (!this.stopped) {
        this.logger.warn('Booking events listener disconnected; retrying.');
        this.reconnect = setTimeout(() => void this.connect(), 5000);
        this.reconnect.unref();
      }
    };
    client.on('error', retry);
    client.on('end', retry);
    client.on('notification', (notification) => {
      if (notification.channel !== channel || !notification.payload) return;
      try {
        const change = JSON.parse(notification.payload) as Change;
        if (!uuid.test(change.companyId) || !Array.isArray(change.professionalIds) || change.professionalIds.length > 8 || change.professionalIds.some(id => typeof id !== 'string' || !uuid.test(id))) return;
        this.events.emit('change', change);
      } catch { /* Ignore malformed messages; no user data is logged. */ }
    });
    try {
      await client.connect(); await client.query('LISTEN kalend_booking_events');
      this.events.emit('reconnected'); // Reload state in case notifications were missed during reconnect.
    } catch { retry(); }
  }

  stream(req: AuthRequest): Observable<MessageEvent> {
    const expected = { userId: req.auth.user.id, companyId: req.tenant!.companyId, membershipId: req.tenant!.membershipId, role: req.tenant!.role };
    const sessionId = req.auth.session.id;
    return new Observable<MessageEvent>((subscriber) => {
      const count = this.connections.get(sessionId) ?? 0;
      if (count >= 3) { subscriber.error(new HttpException('Limite de conexões simultâneas atingido.', 429)); return; }
      this.connections.set(sessionId, count + 1);
      const subscription = merge(
        timer(0, 15000).pipe(map(index => ({ refresh: index === 0 }))),
        fromEvent(this.events, 'reconnected').pipe(map(() => ({ refresh: true }))),
        fromEvent<Change>(this.events, 'change').pipe(filter(change => change.companyId === expected.companyId), map(change => ({ refresh: true, change }))),
      ).pipe(
        concatMap(async (event) => {
          const identity = await this.auth.authenticate(readCookie(req, ACCESS_COOKIE));
          if (identity.user.id !== expected.userId || identity.session.selectedCompanyId !== expected.companyId) throw new ForbiddenException('O contexto da sessão mudou.');
          const membership = await this.auth.membership(identity.user.id, expected.companyId);
          if (membership.id !== expected.membershipId || membership.role !== expected.role) throw new ForbiddenException('O vínculo da sessão mudou.');
          await this.entitlements.current(expected.companyId);
          if ('change' in event && expected.role === 'PROFESSIONAL') {
            const professional = await this.prisma.professionalProfile.findFirst({ where: { companyId: expected.companyId, membershipId: membership.id, active: true }, select: { id: true } });
            if (!professional || !event.change.professionalIds.includes(professional.id)) return { type: 'heartbeat', data: { refresh: false } };
          }
          return { type: event.refresh ? 'booking-change' : 'heartbeat', data: { refresh: event.refresh } };
        }),
        takeUntil(timer(90000)),
        finalize(() => {
          const remaining = (this.connections.get(sessionId) ?? 1) - 1;
          if (remaining) this.connections.set(sessionId, remaining); else this.connections.delete(sessionId);
        }),
      ).subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }
  async onModuleDestroy() {
    this.stopped = true; clearTimeout(this.reconnect);
    await this.client?.end().catch(() => {});
    this.events.removeAllListeners();
  }
}

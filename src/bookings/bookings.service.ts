import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { retryableBillingConflict, withBillingConflictRetry } from '../billing/transaction-conflict.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { assertAvailability, assertItemsDoNotOverlap, assertNoOverlap, assertNoScheduleOverlap, localMinuteToUtc, parseInstant, wallClock } from './booking-domain.js';
import { integer, object, string, uuid } from '../common/validation.js';

const requestSelect = {
  id: true, status: true, createdAt: true, holdExpiresAt: true,
  customer: { select: { id: true, name: true, email: true, phone: true, userId: true } },
  items: { select: { id: true, serviceName: true, priceCents: true, durationMinutes: true, startsAt: true, endsAt: true, professional: { select: { displayName: true } } }, orderBy: { startsAt: 'asc' as const } },
} as const;
const publicRequestSelect = {
  id: true, status: true, createdAt: true,
  items: { select: { serviceName: true, priceCents: true, durationMinutes: true, startsAt: true, professional: { select: { displayName: true } } }, orderBy: { startsAt: 'asc' as const } },
} as const;
type PublicBookingRequest = Prisma.BookingRequestGetPayload<{ select: typeof publicRequestSelect }>;

type RequestedItem = { serviceId: string; professionalId: string; startsAt: Date; endsAt: Date; serviceName: string; durationMinutes: number; priceCents: number };

@Injectable()
export class BookingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  private async publicCompany(slug: string) {
    const company = await this.prisma.company.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, timezone: true, isActive: true, administrativeStatus: true } });
    if (!company || !company.isActive || company.administrativeStatus !== 'ACTIVE') throw new NotFoundException('Estabelecimento não encontrado.');
    await this.entitlements.current(company.id);
    return company;
  }

  async catalog(slug: string) {
    const company = await this.publicCompany(slug);
    const services = await this.prisma.service.findMany({
      where: { companyId: company.id, active: true, public: true, professionalLinks: { some: { professional: { active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } } } },
      select: { id: true, name: true, description: true, category: true, durationMinutes: true, priceCents: true, professionalLinks: { where: { professional: { active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } }, select: { professional: { select: { id: true, displayName: true } } } } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return { company: { name: company.name, slug: company.slug }, timezone: company.timezone, services: services.map(({ professionalLinks, ...service }) => ({ ...service, professionals: professionalLinks.map(({ professional }) => ({ id: professional.id, name: professional.displayName })) })) };
  }

  async availability(slug: string, serviceIdValue: unknown, dateValue: unknown, professionalIdValue?: unknown) {
    const company = await this.publicCompany(slug);
    const serviceId = uuid(serviceIdValue);
    if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw new BadRequestException('Informe uma data válida.');
    const day = new Date(`${dateValue}T12:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== dateValue) throw new BadRequestException('Informe uma data válida.');
    const weekday = day.getUTCDay();
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, companyId: company.id, active: true, public: true }, select: { id: true, durationMinutes: true, professionalLinks: { where: { professional: { active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } }, ...(professionalIdValue ? { professionalId: uuid(professionalIdValue) } : {}) }, select: { professional: { select: { id: true, displayName: true, availability: { where: { weekday, active: true }, select: { startMinute: true, endMinute: true } } } } } } } });
    if (!service) throw new NotFoundException('Serviço não encontrado.');
    const startBound = new Date(`${dateValue}T00:00:00.000Z`);
    startBound.setUTCHours(startBound.getUTCHours() - 15);
    const endBound = new Date(`${dateValue}T23:59:59.999Z`);
    endBound.setUTCHours(endBound.getUTCHours() + 15);
    const occupied = await this.prisma.bookingRequestItem.findMany({ where: { companyId: company.id, startsAt: { lt: endBound }, endsAt: { gt: startBound }, request: { OR: [{ status: 'CONFIRMED' }, { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } }] } }, select: { professionalId: true, startsAt: true, endsAt: true } });
    return { date: dateValue, timezone: company.timezone, professionals: service.professionalLinks.map(({ professional }) => {
      const slots: string[] = [];
      for (const window of professional.availability) {
        for (let minute = window.startMinute; minute + service.durationMinutes <= window.endMinute; minute += 30) {
          const candidate = localMinuteToUtc(dateValue, minute, company.timezone);
          if (candidate <= new Date()) continue;
          const end = new Date(candidate.getTime() + service.durationMinutes * 60_000);
          const local = wallClock(candidate, company.timezone);
          if (local.weekday !== weekday || occupied.some((item) => item.professionalId === professional.id && candidate < item.endsAt && end > item.startsAt)) continue;
          slots.push(candidate.toISOString());
        }
      }
      return { id: professional.id, name: professional.displayName, slots: [...new Set(slots)].sort() };
    }) };
  }

  async request(slug: string, input: unknown, retry = 0, authenticatedUserId?: string): Promise<PublicBookingRequest> {
    const company = await this.publicCompany(slug);
    const body = object(input, ['idempotencyKey', 'customer', 'items', 'termsAccepted', 'marketingOptIn']);
    const idempotencyKey = string(body.idempotencyKey, 'idempotencyKey', 80);
    if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new BadRequestException('Chave de solicitação inválida.');
    if (body.termsAccepted !== true) throw new BadRequestException('Aceite os termos e o aviso de privacidade para continuar.');
    const marketingOptIn = body.marketingOptIn === true;
    if (body.marketingOptIn !== undefined && typeof body.marketingOptIn !== 'boolean') throw new BadRequestException('Consentimento inválido.');
    const customerInput = object(body.customer, ['name', 'email', 'phone']);
    const name = string(customerInput.name, 'name', 160);
    const email = customerInput.email === undefined || customerInput.email === '' ? null : string(customerInput.email, 'email', 254).trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('E-mail inválido.');
    const phone = normalizePhone(string(customerInput.phone, 'phone', 32));
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 8) throw new BadRequestException('Selecione de um a oito serviços.');

    const existing = await this.prisma.bookingRequest.findUnique({ where: { companyId_idempotencyKey: { companyId: company.id, idempotencyKey } }, select: publicRequestSelect });
    if (existing) return existing;
    const requested = body.items.map((raw) => {
      const item = object(raw, ['serviceId', 'professionalId', 'startsAt']);
      return { serviceId: uuid(item.serviceId), professionalId: uuid(item.professionalId), startsAt: parseInstant(item.startsAt) };
    });
    const clientIntervals: Array<{ professionalId: string; startsAt: Date; endsAt: Date }> = [];

    try {
      return await this.prisma.$transaction(async (tx) => {
        const profiles: RequestedItem[] = [];
        for (const item of requested) {
          const service = await tx.service.findFirst({ where: { id: item.serviceId, companyId: company.id, active: true, public: true, professionalLinks: { some: { professionalId: item.professionalId, professional: { active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } } } }, select: { id: true, name: true, durationMinutes: true, priceCents: true } });
          if (!service) throw new BadRequestException('Um dos serviços ou profissionais não está disponível.');
          if (item.startsAt <= new Date()) throw new ConflictException('Escolha um horário futuro.');
          const end = new Date(item.startsAt.getTime() + service.durationMinutes * 60_000);
          assertAvailability(item.startsAt, service.durationMinutes, company.timezone, await tx.professionalAvailability.findMany({ where: { companyId: company.id, professionalId: item.professionalId, active: true }, select: { weekday: true, startMinute: true, endMinute: true } }));
          profiles.push({ ...item, endsAt: end, serviceName: service.name, durationMinutes: service.durationMinutes, priceCents: service.priceCents });
          clientIntervals.push({ professionalId: item.professionalId, startsAt: item.startsAt, endsAt: end });
        }
        assertItemsDoNotOverlap(clientIntervals);
        let customer = email ? await tx.customerProfile.findUnique({ where: { companyId_email: { companyId: company.id, email } } }) : null;
        if (!customer) customer = await tx.customerProfile.findFirst({ where: { companyId: company.id, phone } });
        if (customer?.userId && customer.userId !== authenticatedUserId) throw new ForbiddenException({ code: 'CUSTOMER_LOGIN_REQUIRED', message: 'Entre na conta do cliente para solicitar este agendamento.' });
        if (!customer) {
          const customerCount = await tx.customerProfile.count({ where: { companyId: company.id } });
          await this.entitlements.assertLimit(tx, company.id, 'clients', customerCount);
          customer = await tx.customerProfile.create({ data: { companyId: company.id, name, email, phone } });
        }
        const lockKeys = [
          ...new Set(profiles.map((item) => `${company.id}:professional:${item.professionalId}`)),
          `${company.id}:customer:${customer.id}`,
        ].sort();
        for (const lockKey of lockKeys) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        for (const item of profiles) {
          const conflicts = await tx.bookingRequestItem.findMany({ where: { companyId: company.id, professionalId: item.professionalId, startsAt: { lt: item.endsAt }, endsAt: { gt: item.startsAt }, request: { OR: [{ status: 'CONFIRMED' }, { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } }] } }, select: { startsAt: true, endsAt: true } });
          assertNoOverlap(item.startsAt, item.endsAt, conflicts);
          const customerConflicts = await tx.bookingRequestItem.findMany({ where: { companyId: company.id, startsAt: { lt: item.endsAt }, endsAt: { gt: item.startsAt }, request: { customerId: customer.id, OR: [{ status: 'CONFIRMED' }, { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } }] } }, select: { startsAt: true, endsAt: true } });
          assertNoOverlap(item.startsAt, item.endsAt, customerConflicts);
        }
        const consentedAt = new Date();
        const created = await tx.bookingRequest.create({ data: { companyId: company.id, customerId: customer.id, idempotencyKey, holdExpiresAt: new Date(Date.now() + 10 * 60_000), termsAcceptedAt: consentedAt, termsVersion: '2026-10-28', privacyVersion: '2026-10-28', marketingOptIn, marketingConsentedAt: marketingOptIn ? consentedAt : null, items: { create: profiles.map((item) => ({ serviceId: item.serviceId, professionalId: item.professionalId, serviceName: item.serviceName, durationMinutes: item.durationMinutes, priceCents: item.priceCents, startsAt: item.startsAt, endsAt: item.endsAt })) } }, select: publicRequestSelect });
        const recipients = await tx.membership.findMany({ where: { companyId: company.id, isActive: true, role: { in: ['OWNER', 'ADMIN', 'RECEPTIONIST'] } }, select: { userId: true, role: true } });
        if (recipients.length) await tx.notification.createMany({ data: recipients.map(({ userId, role }) => ({ userId, companyId: company.id, sourceKey: `booking-request:${created.id}`, type: 'BOOKING_REQUESTED', title: 'Nova solicitação de agendamento', message: 'Uma nova solicitação de agendamento aguarda análise.', actionUrl: role === 'RECEPTIONIST' ? '/painel/recepcionista' : '/painel/proprietario', actionLabel: 'Ver solicitação' })), skipDuplicates: true });
        await tx.$queryRaw`SELECT pg_notify('kalend_booking_events', ${JSON.stringify({ companyId: company.id, professionalIds: [...new Set(profiles.map(item => item.professionalId))] })})::text`;
        return created;
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const duplicate = await this.prisma.bookingRequest.findUnique({ where: { companyId_idempotencyKey: { companyId: company.id, idempotencyKey } }, select: publicRequestSelect });
        if (duplicate) return duplicate;
        if (retry < 2) return this.request(slug, input, retry + 1, authenticatedUserId);
      }
      if (isSerializationConflict(error) && retry < 2) return this.request(slug, input, retry + 1, authenticatedUserId);
      throw error;
    }
  }

  async listRequests(companyId: string, role: string, membershipId: string) {
    const requests = await this.prisma.bookingRequest.findMany({ where: { companyId, ...(role === 'PROFESSIONAL' ? { items: { some: { professional: { membershipId } } } } : {}) }, select: { ...requestSelect, items: { ...requestSelect.items, ...(role === 'PROFESSIONAL' ? { where: { professional: { membershipId } } } : {}) } }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100 });
    return role === 'PROFESSIONAL' ? requests.map(({ customer, ...request }) => ({ ...request, customer: { name: customer.name } })) : requests;
  }

  async decide(companyId: string, requestId: string, decision: 'CONFIRMED' | 'REJECTED') {
    return withBillingConflictRetry(() => this.prisma.$transaction(async (tx) => {
      const request = await tx.bookingRequest.findFirst({ where: { id: requestId, companyId }, include: { items: true } });
      if (!request) throw new NotFoundException('Solicitação não encontrada.');
      if (request.status !== 'REQUESTED') throw new ConflictException('A solicitação já foi processada.');
      if (decision === 'CONFIRMED') {
        const lockKeys = [
          ...new Set(request.items.map((item) => `${companyId}:professional:${item.professionalId}`)),
          `${companyId}:customer:${request.customerId}`,
        ].sort();
        for (const lockKey of lockKeys) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        for (const item of request.items) {
          if (item.startsAt <= new Date()) throw new ConflictException('Não é possível confirmar um horário passado.');
          const professional = await tx.professionalProfile.findFirst({ where: { id: item.professionalId, companyId, active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } }, select: { id: true } });
          if (!professional) throw new ConflictException('O profissional não está mais disponível.');
          const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
          assertAvailability(item.startsAt, item.durationMinutes, company.timezone, await tx.professionalAvailability.findMany({ where: { companyId, professionalId: item.professionalId, active: true }, select: { weekday: true, startMinute: true, endMinute: true } }));
          const conflicts = await tx.bookingRequestItem.findMany({ where: { id: { notIn: request.items.map((value) => value.id) }, companyId, professionalId: item.professionalId, startsAt: { lt: item.endsAt }, endsAt: { gt: item.startsAt }, request: { OR: [{ status: 'CONFIRMED' }, { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } }] } }, select: { startsAt: true, endsAt: true } });
          assertNoOverlap(item.startsAt, item.endsAt, conflicts);
          const customerConflicts = await tx.bookingRequestItem.findMany({ where: { id: { notIn: request.items.map((value) => value.id) }, companyId, startsAt: { lt: item.endsAt }, endsAt: { gt: item.startsAt }, request: { id: { not: requestId }, customerId: request.customerId, OR: [{ status: 'CONFIRMED' }, { status: 'REQUESTED', holdExpiresAt: { gt: new Date() } }] } }, select: { startsAt: true, endsAt: true } });
          assertNoOverlap(item.startsAt, item.endsAt, customerConflicts);
        }
      }
      const result = await tx.bookingRequest.updateMany({ where: { id: requestId, companyId, status: 'REQUESTED' }, data: { status: decision } });
      if (result.count !== 1) throw new ConflictException('A solicitação foi processada por outra pessoa.');
      await tx.$queryRaw`SELECT pg_notify('kalend_booking_events', ${JSON.stringify({ companyId, professionalIds: [...new Set(request.items.map(item => item.professionalId))] })})::text`;
      return tx.bookingRequest.findFirstOrThrow({ where: { id: requestId, companyId }, select: requestSelect });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 }));
  }

  async agenda(companyId: string, role: string, membershipId: string, dateValue: unknown) {
    if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) throw new BadRequestException('Informe uma data válida.');
    const date = new Date(`${dateValue}T12:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateValue) throw new BadRequestException('Informe uma data válida.');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
    const nextDay = new Date(date); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const from = localMinuteToUtc(dateValue, 0, company.timezone);
    const to = localMinuteToUtc(nextDay.toISOString().slice(0, 10), 0, company.timezone);
    const items = await this.prisma.bookingRequestItem.findMany({
      where: { companyId, startsAt: { lt: to }, endsAt: { gt: from }, request: { status: 'CONFIRMED' }, ...(role === 'PROFESSIONAL' ? { professional: { membershipId } } : {}) },
      select: { id: true, serviceName: true, startsAt: true, endsAt: true, durationMinutes: true, priceCents: true, professional: { select: { id: true, displayName: true } }, request: { select: { id: true, customer: { select: { name: true } } } } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 1000,
    });
    return { date: dateValue, timezone: company.timezone, items };
  }

  async listServices(companyId: string) {
    return this.prisma.service.findMany({ where: { companyId }, include: { professionalLinks: { select: { professionalId: true } } }, orderBy: { createdAt: 'desc' } });
  }

  async createService(companyId: string, input: unknown) {
    const body = object(input, ['name', 'description', 'category', 'durationMinutes', 'priceCents', 'public', 'professionalIds']);
    const durationMinutes = body.durationMinutes; const priceCents = body.priceCents;
    integer(durationMinutes, 'durationMinutes', 1, 1440); integer(priceCents, 'priceCents', 0, 100_000_000);
    if (body.public !== undefined && typeof body.public !== 'boolean') throw new BadRequestException('Campo inválido: public.');
    if (body.professionalIds !== undefined && (!Array.isArray(body.professionalIds) || body.professionalIds.length > 100)) throw new BadRequestException('Lista de profissionais inválida.');
    const ids = [...new Set(((body.professionalIds ?? []) as unknown[]).map(uuid))];
    return this.prisma.$transaction(async tx => {
      const count = await tx.professionalProfile.count({ where: { id: { in: ids }, companyId, active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } });
      if (count !== ids.length) throw new BadRequestException('Profissionais não disponíveis nesta empresa.');
      return tx.service.create({ data: { companyId, name: string(body.name, 'name', 120), description: body.description === undefined ? null : string(body.description, 'description', 2000), category: body.category === undefined ? null : string(body.category, 'category', 100), durationMinutes: durationMinutes as number, priceCents: priceCents as number, public: body.public as boolean | undefined, professionalLinks: { create: ids.map(professionalId => ({ professionalId })) } } });
    });
  }

  async setupFirstService(companyId: string, input: unknown) {
    const body = object(input, ['service', 'professional', 'availability']);
    const serviceInput = object(body.service, ['name', 'description', 'category', 'durationMinutes', 'priceCents']);
    const professionalInput = object(body.professional, ['membershipId', 'displayName']);
    const durationMinutes = serviceInput.durationMinutes; const priceCents = serviceInput.priceCents;
    integer(durationMinutes, 'durationMinutes', 1, 1440); integer(priceCents, 'priceCents', 0, 100_000_000);
    const membershipId = uuid(professionalInput.membershipId);
    if (!Array.isArray(body.availability) || body.availability.length < 1 || body.availability.length > 70) throw new BadRequestException('Configure ao menos um horário de disponibilidade.');
    const windows = body.availability.map((value) => {
      const entry = object(value, ['weekday', 'startMinute', 'endMinute']);
      integer(entry.weekday, 'weekday', 0, 6); integer(entry.startMinute, 'startMinute', 0, 1439); integer(entry.endMinute, 'endMinute', 1, 1440);
      if ((entry.startMinute as number) >= (entry.endMinute as number)) throw new BadRequestException('Intervalo de disponibilidade inválido.');
      return { weekday: entry.weekday as number, startMinute: entry.startMinute as number, endMinute: entry.endMinute as number };
    });
    assertNoScheduleOverlap(windows);
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findFirst({ where: { id: membershipId, companyId, isActive: true, role: { in: ['PROFESSIONAL', 'OWNER', 'ADMIN'] } } });
      if (!member) throw new ForbiddenException('Vínculo profissional não autorizado para esta empresa.');
      const current = await tx.professionalProfile.count({ where: { companyId, active: true } });
      await this.entitlements.assertLimit(tx, companyId, 'professionals', current);
      const service = await tx.service.create({ data: { companyId, name: string(serviceInput.name, 'name', 120), description: serviceInput.description === undefined ? null : string(serviceInput.description, 'description', 2000), category: serviceInput.category === undefined ? null : string(serviceInput.category, 'category', 100), durationMinutes: durationMinutes as number, priceCents: priceCents as number } });
      const professional = await tx.professionalProfile.create({ data: { companyId, membershipId, displayName: string(professionalInput.displayName, 'displayName', 120), availability: { create: windows }, services: { create: [{ serviceId: service.id }] } }, include: { availability: true, services: true } });
      return { service, professional };
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 });
  }

  async members(companyId: string) {
    return this.prisma.membership.findMany({ where: { companyId, isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } }, select: { id: true, role: true, user: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
  }

  async professionals(companyId: string) {
    return this.prisma.professionalProfile.findMany({ where: { companyId }, select: { id: true, membershipId: true, displayName: true, active: true, availability: { select: { weekday: true, startMinute: true, endMinute: true, active: true } }, services: { select: { serviceId: true } } }, orderBy: { displayName: 'asc' } });
  }

  async createProfessional(companyId: string, input: unknown) {
    const body = object(input, ['membershipId', 'displayName']);
    const membershipId = uuid(body.membershipId);
    return withBillingConflictRetry(() => this.prisma.$transaction(async tx => {
      const member = await tx.membership.findFirst({ where: { id: membershipId, companyId, isActive: true, role: { in: ['PROFESSIONAL', 'OWNER', 'ADMIN'] } } });
      if (!member) throw new ForbiddenException('Vínculo profissional não autorizado para esta empresa.');
      if (await tx.professionalProfile.findFirst({ where: { companyId, membershipId } })) throw new ConflictException('Profissional já cadastrado.');
      const count = await tx.professionalProfile.count({ where: { companyId, active: true } });
      await this.entitlements.assertLimit(tx, companyId, 'professionals', count);
      return tx.professionalProfile.create({ data: { companyId, membershipId, displayName: string(body.displayName, 'displayName', 120) } });
    }, { isolationLevel: 'Serializable' }));
  }

  async updateService(companyId: string, id: string, input: unknown) {
    const body = object(input, ['name', 'description', 'category', 'durationMinutes', 'priceCents', 'active', 'public', 'professionalIds']);
    const data: Prisma.ServiceUpdateManyMutationInput = {};
    if (body.name !== undefined) data.name = string(body.name, 'name', 120);
    for (const key of ['description', 'category'] as const) if (body[key] !== undefined) data[key] = body[key] === null ? null : string(body[key], key, key === 'description' ? 2000 : 100);
    for (const key of ['active', 'public'] as const) if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') throw new BadRequestException('Status inválido.'); data[key] = body[key]; }
    if (body.durationMinutes !== undefined) { integer(body.durationMinutes, 'durationMinutes', 1, 1440); data.durationMinutes = body.durationMinutes as number; }
    if (body.priceCents !== undefined) { integer(body.priceCents, 'priceCents', 0, 100_000_000); data.priceCents = body.priceCents as number; }
    if (!Object.keys(data).length) throw new BadRequestException('Informe uma alteração.');
    if (body.professionalIds !== undefined && (!Array.isArray(body.professionalIds) || body.professionalIds.length > 100)) throw new BadRequestException('Lista de profissionais inválida.');
    const ids = body.professionalIds === undefined ? undefined : [...new Set((body.professionalIds as unknown[]).map(uuid))];
    return this.prisma.$transaction(async tx => {
      if (ids && await tx.professionalProfile.count({ where: { companyId, id: { in: ids }, active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } } }) !== ids.length) throw new BadRequestException('Profissionais não disponíveis nesta empresa.');
      const result = await tx.service.updateMany({ where: { id, companyId }, data });
      if (!result.count) throw new NotFoundException('Serviço não encontrado.');
      if (ids) {
        await tx.serviceProfessional.deleteMany({ where: { companyId, serviceId: id } });
        if (ids.length) await tx.serviceProfessional.createMany({ data: ids.map(professionalId => ({ companyId, serviceId: id, professionalId })) });
      }
      return tx.service.findFirstOrThrow({ where: { id, companyId } });
    });
  }

  async updateProfessional(companyId: string, id: string, input: unknown) {
    const body = object(input, ['displayName', 'active']);
    if (body.active !== undefined && typeof body.active !== 'boolean') throw new BadRequestException('Status inválido.');
    const displayName = body.displayName === undefined ? undefined : string(body.displayName, 'displayName', 120);
    if (displayName === undefined && body.active === undefined) throw new BadRequestException('Informe uma alteração.');
    return withBillingConflictRetry(() => this.prisma.$transaction(async tx => {
      const current = await tx.professionalProfile.findFirst({ where: { id, companyId }, include: { membership: true } });
      if (!current) throw new NotFoundException('Profissional não encontrado.');
      if (body.active === true) {
        if (!current.membership.isActive || !['OWNER', 'ADMIN', 'PROFESSIONAL'].includes(current.membership.role)) throw new ForbiddenException('Vínculo profissional inativo.');
        if (!current.active) await this.entitlements.assertLimit(tx, companyId, 'professionals', await tx.professionalProfile.count({ where: { companyId, active: true } }));
      }
      return tx.professionalProfile.update({ where: { id }, data: { displayName, active: body.active as boolean | undefined } });
    }, { isolationLevel: 'Serializable' }));
  }

  async setAvailability(companyId: string, professionalId: string, input: unknown) {
    const body = object(input, ['windows']);
    if (!Array.isArray(body.windows) || body.windows.length > 70) throw new BadRequestException('Informe uma grade de horários válida.');
    const windows = body.windows.map((value) => {
      const entry = object(value, ['weekday', 'startMinute', 'endMinute']);
      integer(entry.weekday, 'weekday', 0, 6); integer(entry.startMinute, 'startMinute', 0, 1439); integer(entry.endMinute, 'endMinute', 1, 1440);
      if ((entry.startMinute as number) >= (entry.endMinute as number)) throw new BadRequestException('Intervalo de disponibilidade inválido.');
      return { companyId, professionalId, weekday: entry.weekday as number, startMinute: entry.startMinute as number, endMinute: entry.endMinute as number };
    });
    assertNoScheduleOverlap(windows);
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.professionalProfile.findFirst({ where: { id: professionalId, companyId } }))) throw new NotFoundException('Profissional não encontrado.');
      await tx.professionalAvailability.deleteMany({ where: { companyId, professionalId } });
      if (windows.length) await tx.professionalAvailability.createMany({ data: windows });
      return tx.professionalAvailability.findMany({ where: { companyId, professionalId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] });
    });
  }

  async linkProfessionalServices(companyId: string, serviceId: string, input: unknown) {
    const body = object(input, ['professionalIds']);
    if (!Array.isArray(body.professionalIds) || body.professionalIds.length > 100) throw new BadRequestException('Lista de profissionais inválida.');
    const ids = [...new Set(body.professionalIds.map(uuid))];
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.service.findFirst({ where: { id: serviceId, companyId } }))) throw new NotFoundException('Serviço não encontrado.');
      const profiles = await tx.professionalProfile.findMany({ where: { companyId, id: { in: ids }, active: true, membership: { isActive: true, role: { in: ['OWNER', 'ADMIN', 'PROFESSIONAL'] } } }, select: { id: true } });
      if (profiles.length !== ids.length) throw new BadRequestException('Um ou mais profissionais não pertencem à empresa.');
      await tx.serviceProfessional.deleteMany({ where: { companyId, serviceId } });
      if (ids.length) await tx.serviceProfessional.createMany({ data: ids.map((professionalId) => ({ companyId, serviceId, professionalId })) });
      return tx.service.findFirstOrThrow({ where: { id: serviceId, companyId }, include: { professionalLinks: { include: { professional: true } } } });
    });
  }
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '');
  const international = value.trim().startsWith('+') ? digits : digits.length >= 10 && digits.length <= 11 ? `55${digits}` : digits;
  if (!/^\d{10,15}$/.test(international)) throw new BadRequestException('Informe um telefone com DDI.');
  return `+${international}`;
}

function isUniqueConflict(error: unknown): error is { code: string } {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'P2002';
}

function isSerializationConflict(error: unknown): error is { code: string } {
  return retryableBillingConflict(error);
}

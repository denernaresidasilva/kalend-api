import { ForbiddenException } from '@nestjs/common';
import { BookingsService } from './bookings.service.js';

function setup() {
  const company = { id: '11111111-1111-4111-8111-111111111111', name: 'Estúdio QA', slug: 'estudio-qa', timezone: 'America/Sao_Paulo', isActive: true, administrativeStatus: 'ACTIVE' };
  const prisma = {
    company: { findUnique: vi.fn().mockResolvedValue(company) },
    service: { findMany: vi.fn().mockResolvedValue([]) },
    membership: { findFirst: vi.fn().mockResolvedValue(null) },
    bookingRequest: { findUnique: vi.fn() },
    customerProfile: { create: vi.fn() },
  };
  const entitlements = { current: vi.fn().mockResolvedValue({ id: 'entitled' }) };
  return { service: new BookingsService(prisma as never, entitlements as never), prisma, entitlements, company };
}

describe('BookingsService tenant and public safety', () => {
  it('scopes public catalog queries to the slug-resolved company and active public services', async () => {
    const { service, prisma, company, entitlements } = setup();
    await service.catalog(company.slug);
    expect(entitlements.current).toHaveBeenCalledWith(company.id);
    expect(prisma.service.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: company.id, active: true, public: true }) }));
  });

  it('does not create a professional profile from an unlinked or foreign membership', async () => {
    const { service, prisma, company } = setup();
    await expect(service.createProfessional(company.id, { membershipId: '22222222-2222-4222-8222-222222222222', displayName: 'QA' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.membership.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: company.id, isActive: true }) }));
  });

  it('requires consent before creating customer or booking records', async () => {
    const { service, prisma, company } = setup();
    await expect(service.request(company.slug, { idempotencyKey: '11111111-1111-4111-8111-111111111111', customer: { name: 'QA', phone: '+5511999999999' }, items: [] })).rejects.toThrow('Aceite os termos');
    expect(prisma.customerProfile.create).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.findUnique).not.toHaveBeenCalled();
  });
});

import { BadRequestException } from '@nestjs/common';
import { CompanyCommunicationTemplates, resolveEffectiveTemplate } from './company-templates.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('company communication templates', () => {
  it('falls back to GLOBAL only when there is no COMPANY override', () => {
    expect(resolveEffectiveTemplate({ enabled: true, content: 'global' }, null)).toMatchObject({ source: 'GLOBAL', content: 'global' });
    expect(resolveEffectiveTemplate({ enabled: false, content: 'global' }, null)).toMatchObject({ source: 'GLOBAL', enabled: false });
  });

  it('uses active COMPANY override and preserves an explicit disabled override', () => {
    expect(resolveEffectiveTemplate({ enabled: true, content: 'global' }, { enabled: true, content: 'company' })).toMatchObject({ source: 'COMPANY', content: 'company' });
    expect(resolveEffectiveTemplate({ enabled: true, content: 'global' }, { enabled: false, content: 'company' })).toMatchObject({ source: 'COMPANY', enabled: false, content: 'company' });
  });

  it('upserts by trusted companyId + event + channel without accepting companyId in body', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'override', revision: 1, enabled: true });
    const log = vi.fn();
    const tx = { companyCommunicationTemplate: { upsert }, globalCommunicationLog: { create: log } };
    const db = { $transaction: vi.fn(async (fn) => fn(tx)) };
    const defaults = { ensure: vi.fn().mockResolvedValue(0) };
    const service = new CompanyCommunicationTemplates(db as never, defaults as never);

    await service.save(companyId, 'OWNER_WELCOME', 'EMAIL', {
      enabled: true,
      content: { subject: 'Olá {{nome}}', text: 'Bem-vinda à {{empresa}}' },
    }, actorId);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId_event_channel: { companyId, event: 'OWNER_WELCOME', channel: 'EMAIL' } },
      create: expect.objectContaining({ companyId, event: 'OWNER_WELCOME', channel: 'EMAIL', enabled: true }),
    }));
    expect(log).toHaveBeenCalledWith({ data: expect.objectContaining({ scope: 'COMPANY', actorId, code: companyId }) });
    expect(defaults.ensure).toHaveBeenCalledTimes(1);
  });

  it('lists only the selected tenant override and leaves another company on GLOBAL fallback', async () => {
    const globalRows = [{ event: 'OWNER_WELCOME', channel: 'EMAIL', enabled: true, content: { subject: 'Global', text: 'global' }, revision: 1 }];
    const findMany = vi.fn(async ({ where }: { where: { companyId?: string } }) =>
      where.companyId === companyId
        ? [{ event: 'OWNER_WELCOME', channel: 'EMAIL', enabled: true, content: { subject: 'Empresa A', text: 'A' }, revision: 2 }]
        : [],
    );
    const db = {
      globalCommunicationTemplate: { findMany: vi.fn().mockResolvedValue(globalRows) },
      companyCommunicationTemplate: { findMany },
    };
    const service = new CompanyCommunicationTemplates(db as never, { ensure: vi.fn() } as never);
    const a = await service.list(companyId);
    const b = await service.list('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(a.find((row) => row.event === 'OWNER_WELCOME' && row.channel === 'EMAIL')).toMatchObject({ source: 'COMPANY', content: { subject: 'Empresa A' } });
    expect(b.find((row) => row.event === 'OWNER_WELCOME' && row.channel === 'EMAIL')).toMatchObject({ source: 'GLOBAL', content: { subject: 'Global' } });
    expect(findMany.mock.calls.map(([arg]) => arg.where.companyId)).toEqual([companyId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  });

  it('rejects a caller-supplied companyId and invalid placeholders', async () => {
    const service = new CompanyCommunicationTemplates({} as never, { ensure: vi.fn() } as never);
    await expect(service.save(companyId, 'OWNER_WELCOME', 'EMAIL', {
      companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', enabled: true,
      content: { subject: 'Hello', text: 'Hello' },
    }, actorId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.save(companyId, 'OWNER_WELCOME', 'EMAIL', {
      enabled: true, content: { subject: 'Hello {{valor}}', text: 'Hello' },
    }, actorId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restores GLOBAL by deleting only the selected company override', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const global = vi.fn().mockResolvedValue({ enabled: true, content: { subject: 'global', text: 'global' }, revision: 1 });
    const log = vi.fn();
    const tx = { companyCommunicationTemplate: { deleteMany }, globalCommunicationTemplate: { findUnique: global }, globalCommunicationLog: { create: log } };
    const service = new CompanyCommunicationTemplates({ $transaction: vi.fn(async (fn) => fn(tx)) } as never, { ensure: vi.fn() } as never);
    const restored = await service.restore(companyId, 'OWNER_WELCOME', 'EMAIL', actorId);
    expect(deleteMany).toHaveBeenCalledWith({ where: { companyId, event: 'OWNER_WELCOME', channel: 'EMAIL' } });
    expect(restored).toMatchObject({ source: 'GLOBAL', hasOverride: false, content: { subject: 'global' } });
  });
});

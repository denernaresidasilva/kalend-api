import { GLOBAL_TEMPLATE_DEFAULTS, GlobalTemplateDefaults } from './template-defaults.js';
import { EVENTS, variablesFor, templateContent } from './contracts.js';

describe('global communication template defaults', () => {
  it('defines complete valid content for every real event and channel', () => {
    expect(EVENTS).toHaveLength(13);
    expect(GLOBAL_TEMPLATE_DEFAULTS).toHaveLength(EVENTS.length * 3);
    for (const row of GLOBAL_TEMPLATE_DEFAULTS) {
      expect(row.scope).toBe('GLOBAL');
      expect(row.enabled).toBe(true);
      expect(row.content.text).toBeTruthy();
      expect(() => templateContent(row.content, row.channel, row.event)).not.toThrow();
      const allowed = variablesFor(row.event);
      const placeholders = [...row.content.text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]);
      expect(placeholders.every((key) => allowed.includes(key))).toBe(true);
      if (row.channel === 'EMAIL') expect(row.content.subject).toBeTruthy();
      if (row.channel === 'PUSH') expect(row.content.title).toBeTruthy();
    }
  });

  it('uses insert-only createMany with duplicate skipping and does not update existing rows', async () => {
    const createMany = vi.fn().mockResolvedValueOnce({ count: 39 }).mockResolvedValueOnce({ count: 0 });
    const service = new GlobalTemplateDefaults({ globalCommunicationTemplate: { createMany } } as never);
    expect(await service.ensure()).toBe(39);
    expect(await service.ensure()).toBe(0);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany).toHaveBeenNthCalledWith(1, {
      data: GLOBAL_TEMPLATE_DEFAULTS,
      skipDuplicates: true,
    });
    expect(createMany.mock.calls[0][0]).toEqual(createMany.mock.calls[1][0]);
  });
});

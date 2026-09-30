import { adminList, listStatus } from './admin-list.js';
describe('bounded compatible admin list queries', () => {
  it('defaults to 100 and supports bounded offset, search and statuses', () => {
    expect(adminList()).toMatchObject({ take: 100, skip: 0 });
    expect(
      adminList({ limit: '25', offset: '50', q: 'empresa', status: 'ACTIVE' }),
    ).toEqual({ take: 25, skip: 50, q: 'empresa', status: 'ACTIVE' });
    expect(listStatus('ACTIVE', ['ACTIVE'])).toBe('ACTIVE');
  });
  it.each([
    { limit: '101' },
    { limit: '-1' },
    { limit: '0' },
    { offset: '1000001' },
    { q: ['x'] },
    { q: 'x'.repeat(101) },
    { status: {} },
    { scope: 'TENANT' },
  ])('rejects unsafe query %s', (query) =>
    expect(() => adminList(query)).toThrow(),
  );
  it('rejects unknown status', () =>
    expect(() => listStatus('bad', ['ACTIVE'])).toThrow());
});

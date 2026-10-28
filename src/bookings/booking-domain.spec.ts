import { assertAvailability, assertItemsDoNotOverlap, assertNoOverlap, assertNoScheduleOverlap, localMinuteToUtc, parseInstant, wallClock } from './booking-domain.js';

describe('booking-domain', () => {
  it('uses the company timezone when checking a weekly schedule', () => {
    const mondayAtTenSaoPaulo = new Date('2026-10-26T13:00:00.000Z');
    expect(wallClock(mondayAtTenSaoPaulo, 'America/Sao_Paulo')).toEqual({ weekday: 1, minute: 600 });
    expect(() => assertAvailability(mondayAtTenSaoPaulo, 60, 'America/Sao_Paulo', [{ weekday: 1, startMinute: 540, endMinute: 720 }])).not.toThrow();
    expect(() => assertAvailability(mondayAtTenSaoPaulo, 60, 'America/Sao_Paulo', [{ weekday: 1, startMinute: 600, endMinute: 630 }])).toThrow();
  });

  it('treats adjacent intervals as available and overlapping intervals as conflicts', () => {
    const intervals = [{ startsAt: new Date('2026-10-26T13:00:00Z'), endsAt: new Date('2026-10-26T14:00:00Z') }];
    expect(() => assertNoOverlap(new Date('2026-10-26T14:00:00Z'), new Date('2026-10-26T14:30:00Z'), intervals)).not.toThrow();
    expect(() => assertNoOverlap(new Date('2026-10-26T13:30:00Z'), new Date('2026-10-26T14:30:00Z'), intervals)).toThrow();
  });

  it('rejects overlapping services for the same professional in one request', () => {
    const first = { professionalId: 'p1', startsAt: new Date('2026-10-26T13:00:00Z'), endsAt: new Date('2026-10-26T14:00:00Z') };
    expect(() => assertItemsDoNotOverlap([first, { ...first, startsAt: new Date('2026-10-26T13:30:00Z') }])).toThrow();
    expect(() => assertItemsDoNotOverlap([first, { ...first, professionalId: 'p2', startsAt: new Date('2026-10-26T13:00:00Z') }])).toThrow();
    expect(() => assertItemsDoNotOverlap([
      { ...first, startsAt: new Date('2026-10-26T10:00:00Z'), endsAt: new Date('2026-10-26T14:00:00Z') },
      { ...first, professionalId: 'p2', startsAt: new Date('2026-10-26T11:00:00Z'), endsAt: new Date('2026-10-26T12:00:00Z') },
      { ...first, professionalId: 'p3', startsAt: new Date('2026-10-26T13:00:00Z'), endsAt: new Date('2026-10-26T15:00:00Z') },
    ])).toThrow();
  });

  it('requires explicit UTC instants and rejects overlapping availability windows', () => {
    expect(parseInstant('2026-10-26T13:00:00.000Z').toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(() => parseInstant('2026-10-26T10:00:00')).toThrow();
    expect(() => assertNoScheduleOverlap([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 800 }])).toThrow();
    expect(() => assertNoScheduleOverlap([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 800 }])).not.toThrow();
    expect(() => assertNoScheduleOverlap([{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 1, startMinute: 600, endMinute: 660 }, { weekday: 1, startMinute: 960, endMinute: 1080 }])).toThrow();
  });

  it('converts company wall-clock availability to UTC and rejects nonexistent DST times', () => {
    expect(localMinuteToUtc('2026-10-26', 600, 'America/Sao_Paulo').toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(() => localMinuteToUtc('2026-03-08', 150, 'America/New_York')).toThrow();
  });
});

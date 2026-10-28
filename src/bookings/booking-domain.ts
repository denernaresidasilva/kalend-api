import { BadRequestException, ConflictException } from '@nestjs/common';

export function parseInstant(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value))
    throw new BadRequestException('Informe data e horário em ISO UTC.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException('Data inválida.');
  return date;
}

export function wallClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays.indexOf(value('weekday') ?? '');
  if (weekday < 0) throw new BadRequestException('Fuso horário inválido.');
  return { weekday, minute: Number(value('hour')) * 60 + Number(value('minute')) };
}

export function localMinuteToUtc(date: string, minute: number, timezone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const hour = Math.floor(minute / 60);
  const minuteOfHour = minute % 60;
  const target = Date.UTC(year!, month! - 1, day!, hour, minuteOfHour);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(candidate));
    const part = (type: string) => Number(local.find((value) => value.type === type)?.value);
    const rendered = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
    const correction = target - rendered;
    if (!correction) return new Date(candidate);
    candidate += correction;
  }
  throw new ConflictException('Horário local indisponível devido à mudança de fuso horário.');
}

export function assertAvailability(
  start: Date,
  durationMinutes: number,
  timezone: string,
  windows: Array<{ weekday: number; startMinute: number; endMinute: number }>,
) {
  const local = wallClock(start, timezone);
  const endMinute = local.minute + durationMinutes;
  if (!windows.some((window) => window.weekday === local.weekday && local.minute >= window.startMinute && endMinute <= window.endMinute))
    throw new ConflictException('Horário fora da disponibilidade do profissional.');
}

export function assertNoOverlap(start: Date, end: Date, intervals: Array<{ startsAt: Date; endsAt: Date }>) {
  if (intervals.some((item) => start < item.endsAt && end > item.startsAt))
    throw new ConflictException('Este horário acabou de ficar indisponível. Escolha outro.');
}

export function assertItemsDoNotOverlap(items: Array<{ professionalId: string; startsAt: Date; endsAt: Date }>) {
  const sorted = [...items].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let furthestEnd: Date | null = null;
  for (const current of sorted) {
    if (furthestEnd && current.startsAt < furthestEnd) throw new ConflictException('Os serviços selecionados possuem horários incompatíveis para o mesmo cliente.');
    if (!furthestEnd || current.endsAt > furthestEnd) furthestEnd = current.endsAt;
  }
}

export function assertNoScheduleOverlap(windows: Array<{ weekday: number; startMinute: number; endMinute: number }>) {
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  let weekday = -1;
  let furthestEnd = -1;
  for (const current of sorted) {
    if (current.weekday !== weekday) { weekday = current.weekday; furthestEnd = -1; }
    if (current.startMinute < furthestEnd)
      throw new BadRequestException('Há intervalos sobrepostos na disponibilidade.');
    furthestEnd = Math.max(furthestEnd, current.endMinute);
  }
}

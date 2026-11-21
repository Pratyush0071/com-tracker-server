const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface ISTDateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  dateStr: string; // YYYY-MM-DD
  timeStr: string; // HH:mm:ss
}

export function getISTParts(date: Date = new Date()): ISTDateParts {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const day = ist.getUTCDate();
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const second = ist.getUTCSeconds();

  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const timeStr = `${pad(hour)}:${pad(minute)}:${pad(second)}`;

  return { year, month, day, hour, minute, second, dateStr, timeStr };
}

export function istDateToUtcStart(year: number, month: number, day: number): Date {
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(utcMidnight - IST_OFFSET_MS);
}

export function parseISTDateStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return istDateToUtcStart(y, m, d);
}

export function parseISTDateEnd(dateStr: string): Date {
  const start = parseISTDateStart(dateStr);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

export function formatISTDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12 + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}

export interface CycleBounds {
  cycleKey: string; // e.g. "2026-10-20_to_2026-11-20"
  startDateIST: string; // "2026-10-20"
  endDateIST: string; // "2026-11-20"
  label: string; // "20 Oct 2026 – 20 Nov 2026"
  startTimestamp: Date; // Inclusive: 20th 00:00:00.000 IST
  endTimestamp: Date; // Exclusive cutoff timestamp: next 20th 00:00:00.000 IST
}

export function getCycleBoundsForDate(date: Date = new Date(), cycleDay: number = 20): CycleBounds {
  const parts = getISTParts(date);
  let startYM: { year: number; month: number };
  let endYM: { year: number; month: number };

  if (parts.day >= cycleDay) {
    startYM = { year: parts.year, month: parts.month };
    endYM = shiftMonth(parts.year, parts.month, 1);
  } else {
    startYM = shiftMonth(parts.year, parts.month, -1);
    endYM = { year: parts.year, month: parts.month };
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const startDateIST = `${startYM.year}-${pad(startYM.month)}-${pad(cycleDay)}`;
  const endDateIST = `${endYM.year}-${pad(endYM.month)}-${pad(cycleDay)}`;
  const cycleKey = `${startDateIST}_to_${endDateIST}`;
  const startTimestamp = istDateToUtcStart(startYM.year, startYM.month, cycleDay);
  const endTimestamp = istDateToUtcStart(endYM.year, endYM.month, cycleDay);
  const label = `${formatISTDateLabel(startDateIST)} – ${formatISTDateLabel(endDateIST)}`;

  return {
    cycleKey,
    startDateIST,
    endDateIST,
    label,
    startTimestamp,
    endTimestamp,
  };
}

export function getRemainingDaysInCycle(endTimestamp: Date, now: Date = new Date()): number {
  const parts = getISTParts(now);
  const todayStart = istDateToUtcStart(parts.year, parts.month, parts.day);
  const diffDays = Math.ceil((endTimestamp.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, diffDays);
}

export function getYesterdayISTDateStr(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return getISTParts(yesterday).dateStr;
}

export function getThisWeekStartISTDateStr(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const dayOfWeek = ist.getUTCDay(); // 0 Sun .. 6 Sat
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
  return getISTParts(monday).dateStr;
}

export function getCalendarMonthRangeIST(now: Date = new Date(), monthDelta: number = 0): {
  startDateIST: string;
  endDateIST: string;
  monthKey: string;
} {
  const parts = getISTParts(now);
  const target = shiftMonth(parts.year, parts.month, monthDelta);
  const pad = (n: number) => String(n).padStart(2, '0');
  const daysInMonth = new Date(Date.UTC(target.year, target.month, 0)).getUTCDate();
  return {
    startDateIST: `${target.year}-${pad(target.month)}-01`,
    endDateIST: `${target.year}-${pad(target.month)}-${pad(daysInMonth)}`,
    monthKey: `${target.year}-${pad(target.month)}`,
  };
}

export function getNextWithdrawalDateIST(now: Date = new Date(), withdrawalDay: number = 20): string {
  const parts = getISTParts(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (parts.day <= withdrawalDay) {
    return `${parts.year}-${pad(parts.month)}-${pad(withdrawalDay)}`;
  }
  const next = shiftMonth(parts.year, parts.month, 1);
  return `${next.year}-${pad(next.month)}-${pad(withdrawalDay)}`;
}

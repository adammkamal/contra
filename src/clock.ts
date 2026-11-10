export interface Clock {
  now(): Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/**
 * Adds Monday-Friday days, keeping the time of day. Counting starts the day after `d`, so a notice
 * sent on a Saturday has its first working day on Monday. Weekdays are taken in UTC and public
 * holidays are NOT excluded (stated limitation; production needs the job's time zone and calendar).
 */
export function addWorkingDays(d: Date, days: number): Date {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error(`working days must be a non-negative integer, got ${days}`);
  let t = d.getTime();
  let counted = 0;
  while (counted < days) {
    t += DAY_MS;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) counted++;
  }
  return new Date(t);
}

export function windowCloses(sentAt: Date, w: { amount: number; unit: "hours" | "calendar_days" | "working_days" }): Date {
  if (!Number.isSafeInteger(w.amount) || w.amount <= 0) throw new Error(`response window must be a positive integer, got ${w.amount}`);
  switch (w.unit) {
    case "hours":
      return new Date(sentAt.getTime() + w.amount * 60 * 60 * 1000);
    case "calendar_days":
      return addDays(sentAt, w.amount);
    case "working_days":
      return addWorkingDays(sentAt, w.amount);
  }
}

export function describeWindow(w: { amount: number; unit: "hours" | "calendar_days" | "working_days" }): string {
  const label = { hours: "hours", calendar_days: "calendar days", working_days: "working days" }[w.unit];
  return `${w.amount} ${label}`;
}

/** A workspace's clock: reads the time, and "advance a week" moves it ahead. */
export interface WorkspaceClock extends Clock {
  advanceDays(days: number): void;
}

/**
 * The live workspace's clock: the real time plus an offset that starts at 0. Only advanceDays changes the
 * offset. The real clock is injected by the host (server/), so src/ never reads the clock itself.
 */
export class OffsetClock implements WorkspaceClock {
  #offsetMs: number;
  constructor(
    private readonly real: Clock,
    offsetMs = 0,
  ) {
    if (!Number.isSafeInteger(offsetMs)) throw new Error(`clock offset must be a whole number of ms, got ${offsetMs}`);
    this.#offsetMs = offsetMs;
  }
  get offsetMs(): number {
    return this.#offsetMs;
  }
  now(): Date {
    return new Date(this.real.now().getTime() + this.#offsetMs);
  }
  advanceDays(days: number): void {
    this.#offsetMs += days * DAY_MS;
  }
}

/** Demo and test clock. "A week later" is advanceDays(7). */
export class ManualClock implements WorkspaceClock {
  #t: number;
  constructor(start: Date) {
    this.#t = start.getTime();
  }
  now(): Date {
    return new Date(this.#t);
  }
  advanceDays(days: number): void {
    this.#t += days * DAY_MS;
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }
}

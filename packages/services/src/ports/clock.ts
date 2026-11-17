/**
 * Time as a dependency.
 *
 * Several rules are deadlines: a 30-second mission offer, a 3-minute
 * substitution window, a 10-minute no-courier timeout, a 30-minute group
 * order. Injecting the clock is what makes those testable without sleeping.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test double. Time only moves when the test moves it. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-11-17T18:00:00Z')) {
    this.current = start;
  }

  now(): Date { return new Date(this.current); }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

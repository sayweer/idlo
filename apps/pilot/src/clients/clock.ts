/** Saat: canlıda sistem saati, kayıt oynatmada simüle saat (§11.2, C2). OKX ms. */
export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/** Elle ilerletilen saat (test ve kayıt oynatma). */
export class ManualClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

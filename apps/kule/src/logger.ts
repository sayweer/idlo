/**
 * Günlük (§9.4): logs/kule-YYYYMMDD.jsonl — zaman, araç, girdi özeti, kontroller, verdict, readback, ordId, tx, mod.
 * Anahtar, imza, parola ve token asla yazılmaz (anahtar adına göre ayıklanır, util.redact).
 * Tarih Türkiye saatine göredir (sabit UTC+3, CLAUDE.md kural 8).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { msToSec, trParts } from "@pilot/shared";
import type { Clock } from "./util.js";
import { redact } from "./util.js";

export interface Logger {
  /** Kaydı yazar ve yazılan SATIRI (anahtarlar ayıklanmış JSON) döndürür; reportHash = keccak256(satır). */
  log(record: Record<string, unknown>): string;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export class JsonlLogger implements Logger {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
    private readonly mode: string,
  ) {}

  log(record: Record<string, unknown>): string {
    const nowMs = this.clock.nowMs();
    const p = trParts(msToSec(nowMs));
    const line = JSON.stringify(redact({ ts: new Date(nowMs).toISOString(), mode: this.mode, ...record }));
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `kule-${p.year}${two(p.month)}${two(p.day)}.jsonl`), line + "\n", "utf8");
    } catch {
      /* günlük yazılamıyorsa işlem durdurulmaz; satır yine de rapor özeti için döner */
    }
    return line;
  }
}

/** Testler için bellekte tutan günlük. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  constructor(private readonly clock: Clock = { nowMs: () => Date.now() }) {}
  log(record: Record<string, unknown>): string {
    const line = JSON.stringify(redact({ ts: new Date(this.clock.nowMs()).toISOString(), ...record }));
    this.lines.push(line);
    return line;
  }
  records(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

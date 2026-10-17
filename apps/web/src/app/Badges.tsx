import { DEMO_LABELS, MODE_LABELS } from "@pilot/shared";
import { isMockFeed } from "../lib/data/mode";

/**
 * Mod rozetleri (UI_HANDOFF §5 kural 2): DEMO / KAYIT / KÂĞIT / TEMSİLİ VERİ … her zaman görünür, küçük not değil rozettir.
 * Metinler @pilot/shared'den; yalnız TEMSİLİ VERİ / KAYIT / DEMO PLANI / CANLI adları SPEC'te yoksa burada (TODO(spec)).
 * Renk: kırmızı yalnız ret ve alarm içindir; rozetler mürekkep/pirinç tonundadır.
 */
export type BadgeKind =
  | "mock" // mock besleme → TEMSİLİ VERİ
  | "replay" // KAYIT
  | "demo" // OKX demo hesabı → DEMO
  | "paper" // KULE_EXEC=paper → KÂĞIT
  | "live" // CANLI
  | "injection" // ENJEKSİYON DEMOSU
  | "mockPay" // TEMSİLİ ÖDEME
  | "rules" // LLM yok, kural modu
  | "demoPlan"; // DEMO PLANI

export const BADGE_TEXT: Record<BadgeKind, string> = {
  mock: "TEMSİLİ VERİ",
  replay: "KAYIT",
  demo: MODE_LABELS.demo,
  paper: MODE_LABELS.paper,
  live: MODE_LABELS.live,
  injection: DEMO_LABELS.injectionDemo,
  mockPay: DEMO_LABELS.mockFacilitator,
  rules: DEMO_LABELS.rulesMode,
  demoPlan: "DEMO PLANI",
};

export function Badge({ kind }: { kind: BadgeKind }) {
  return <span className={`rozet rozet-${kind}`}>{BADGE_TEXT[kind]}</span>;
}

/** Bir kutunun başlığında ya da header'da: verilen modların hepsi görünür; mock besleme açıksa TEMSİLİ VERİ kendiliğinden eklenir. */
export function Badges({ kinds = [], mock = true }: { kinds?: BadgeKind[]; mock?: boolean }) {
  const all = mock && isMockFeed && !kinds.includes("mock") ? (["mock", ...kinds] as BadgeKind[]) : kinds;
  if (all.length === 0) return null;
  return (
    <span className="rozetler" role="status">
      {all.map((k) => <Badge key={k} kind={k} />)}
    </span>
  );
}

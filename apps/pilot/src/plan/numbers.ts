/**
 * Metindeki sayılar (L-3 kod koruması): LLM'in `source:"user"` dediği her sayı kullanıcının metninde geçmeli.
 * Rakamlar ("20.000", "1'inde", "1,5 bin") ve Türkçe sayı sözcükleri ("on beş bin", "beşine") tanınır.
 * Bu yalnız bir izin listesidir: fazladan tanınan sayı korumayı biraz gevşetir, tanınmayan sayı ise
 * alanı soruya çevirir (fail-closed).
 */

/** Sayı sözcüğü kökleri (ek almamış hâl). */
const UNIT_STEMS: ReadonlyArray<readonly [string, number]> = [
  ["sıfır", 0], ["bir", 1], ["iki", 2], ["üç", 3], ["dört", 4], ["beş", 5], ["altı", 6], ["yedi", 7],
  ["sekiz", 8], ["dokuz", 9], ["on", 10], ["yirmi", 20], ["otuz", 30], ["kırk", 40], ["elli", 50],
  ["altmış", 60], ["yetmiş", 70], ["seksen", 80], ["doksan", 90],
];
const SCALE_STEMS: ReadonlyArray<readonly [string, number]> = [
  ["milyon", 1_000_000],
  ["bin", 1_000],
  ["yüz", 100],
];

const VOWELS = "aeıioöuü";
/** Son ünlüye göre büyük (ı/i/u/ü) ve küçük (a/e) ünlü uyumu. */
function harmony(stem: string): { h: string; a: string } {
  const v = [...stem].reverse().find((c) => VOWELS.includes(c)) ?? "i";
  if (v === "e" || v === "i") return { h: "i", a: "e" };
  if (v === "a" || v === "ı") return { h: "ı", a: "a" };
  if (v === "o" || v === "u") return { h: "u", a: "a" };
  return { h: "ü", a: "e" };
}

/**
 * Sayı sözcüğünün kabul edilen ekleri (hâl, iyelik+hâl, sıra sayısı, -lik). Kapalı liste: "binance", "binlerce",
 * "milyoner", "onay", "biraz", "altında", "yüzlerce" gibi sözcükler sayı değildir. Şüphede tanımamak fail-closed
 * yöndür (alan soruya döner).
 */
function suffixes(stem: string): string[] {
  const { h, a } = harmony(stem);
  const ordinal = (base: string) =>
    ["", `s${h}`, `s${h}n${a}`, `s${h}nd${a}`, `y${a}`, `d${a}`, `y${h}`].map((t) => base + t);
  if (VOWELS.includes(stem.at(-1)!)) {
    return [
      "", `y${h}`, `y${a}`, `d${a}`, `d${a}n`, `n${h}n`, `s${h}`, `s${h}n${a}`, `s${h}nd${a}`, `s${h}nd${a}n`,
      `s${h}n${h}n`, `l${h}k`, ...ordinal(`nc${h}`),
    ];
  }
  return [
    "", h, a, `d${a}`, `t${a}`, `d${a}n`, `t${a}n`, `${h}n`, `${h}n${a}`, `${h}nd${a}`, `${h}nd${a}n`, `${h}n${h}n`,
    `l${h}k`, ...ordinal(`${h}nc${h}`),
  ];
}

/** "yüz" yüz/yüzde/bu yüzden ile, "on"un bazı hâlleri o/ona/onu zamiriyle çakışır: yalnız bu dar biçimler sayılır. */
const SCALE_FORMS_OVERRIDE: Record<string, string[]> = { yüz: ["", "lük", "üncü"] };
const PRONOUN_CLASHES = new Set(["ona", "onu", "onun", "onda", "ondan"]);

/** Tam sözcük → [değer, ölçek mi, ek almış mı]. */
const NUMBER_FORMS: ReadonlyMap<string, readonly [number, boolean, boolean]> = (() => {
  const m = new Map<string, readonly [number, boolean, boolean]>();
  const add = (stem: string, v: number, scale: boolean) => {
    for (const sfx of SCALE_FORMS_OVERRIDE[stem] ?? suffixes(stem)) {
      // dört → dördü, dördüncü (ünsüz yumuşaması)
      const base = stem === "dört" && VOWELS.includes(sfx[0] ?? "") ? "dörd" : stem;
      const form = base + sfx;
      if (!PRONOUN_CLASHES.has(form)) m.set(form, [v, scale, sfx !== ""]);
    }
  };
  for (const [w, v] of UNIT_STEMS) add(w, v, false);
  for (const [w, v] of SCALE_STEMS) add(w, v, true);
  return m;
})();

/** "20.000" → 20000, "1,5" → 1.5, "1.5" → 1.5; tanınmayan biçim → NaN. */
function parseDigits(tok: string): number {
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(tok)) return Number(tok.replaceAll(".", "").replace(",", "."));
  if (/^\d+(,\d+)?$/.test(tok)) return Number(tok.replace(",", "."));
  if (/^\d+\.\d+$/.test(tok)) return Number(tok);
  return Number.NaN;
}

/** Metinde geçen tüm sayılar (ara değerler dahil: "20 bin" → {20, 20000}). */
export function numbersInText(text: string): Set<number> {
  const out = new Set<number>();
  // Rakam, sözcük ya da tek noktalama işareti (noktalama sayıyı bitirir: "20 bin, 5'ine" → 20000 ve 5, 20005 değil).
  const tokens = text.toLocaleLowerCase("tr-TR").match(/\d+(?:[.,]\d+)*|[a-zçğıöşüâîû]+|[^\s\da-zçğıöşüâîû]/gu) ?? [];
  let total = 0;
  let cur = 0;
  let any = false;
  const flush = () => {
    if (any) out.add(total + cur);
    total = 0;
    cur = 0;
    any = false;
  };

  for (const [idx, tok] of tokens.entries()) {
    if (/^\d/.test(tok)) {
      flush(); // rakam her zaman yeni sayı başlatır ("20 30", "20 bin 5")
      const v = parseDigits(tok);
      if (Number.isNaN(v)) continue;
      cur = v;
      any = true;
      out.add(v);
      continue;
    }
    const hit = NUMBER_FORMS.get(tok);
    if (!hit) {
      flush();
      continue;
    }
    const [v, scale, suffixed] = hit;
    // Yalın "bir" çoğunlukla belirsiz tanımlıktır ("bir şey"): yalnız sayı içinde ("yirmi bir") ya da
    // "milyon"dan önce sayılır.
    if (tok === "bir" && !any && NUMBER_FORMS.get(tokens[idx + 1] ?? "")?.[0] !== 1_000_000) {
      flush();
      continue;
    }
    if (!scale) {
      cur += v;
      out.add(v);
    } else if (v === 100) {
      cur = (cur || 1) * 100;
    } else {
      total += (cur || 1) * v;
      cur = 0;
    }
    any = true;
    if (suffixed) flush(); // ek almış sözcük ("bininin", "beşine") sayıyı bitirir
  }
  flush();
  return out;
}

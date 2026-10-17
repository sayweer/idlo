// Geçici açılış sayfası (SPEC §13 "/"). Cüzdan bağlantısı D1 adımında eklenecek.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">PİLOT</h1>
      <p className="max-w-md text-base leading-7 opacity-80">
        Uçuş Planı&apos;nı sen imzalarsın; PİLOT yalnız o planın içinde TL&apos;yi
        USDT&apos;ye çevirir.
      </p>
      <p className="text-sm opacity-60">Hazırlanıyor — cüzdan bağlantısı yakında.</p>
    </main>
  );
}

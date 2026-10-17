import { Placeholder, Shell } from "./Shell";

// TODO: ekranı dolduran ajan burayı yazar. Veri: PİLOT beslemesi (pilotFeed) ve KULE durumu (kuleStatus) bağdaştırıcılarına bağlanacak.
export default function Panel() {
  return (
    <Shell>
      <Placeholder label="/panel" title="Panel" note="Ajanın turları, Lira Hava Durumu ve KULE durumu burada görünecek." />
    </Shell>
  );
}

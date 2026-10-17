import { Placeholder, Shell } from "./Shell";

// TODO: ekranı dolduran ajan burayı yazar. Veri: chat → ERC-8004 ajanlar → kod eşiği → LLM sıralama → seçim → Uçuş Planı → imza.
export default function Secim() {
  return (
    <Shell>
      <Placeholder label="/secim" title="Ajan seç" note="Derdini yaz, ERC-8004 kimliği ve itibarı kodla elenen adaylardan seç; seçtiğin ajan için Uçuş Planı taslağı onay penceresine gelir." />
    </Shell>
  );
}

import { Placeholder, Shell } from "./Shell";

// TODO: ekranı dolduran ajan burayı yazar. Veri: ERC-8004 Identity kaydı ve agent.json kartı.
export default function Ajan() {
  return (
    <Shell>
      <Placeholder label="/ajan" title="Ajan" note="Seçilen ajanın ERC-8004 kimliği ve servisleri." />
    </Shell>
  );
}

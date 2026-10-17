import { Placeholder, Shell } from "./Shell";

// TODO: ekranı dolduran ajan burayı yazar. Veri: plan okuma (useChainReads) ve setPlan / revoke imzası, yalnız onay penceresinden.
export default function Yetkiler() {
  return (
    <Shell>
      <Placeholder label="/yetkiler" title="Yetkiler" note="Sınırlarını düşür, yükselt ya da her şeyi durdur." />
    </Shell>
  );
}

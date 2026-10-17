// deployments/fuji.json (kök) → public/deployments/fuji.json. predev/prebuild'de çalışır.
// Dosya yoksa build kırılmaz: bayat kopya silinir ve arayüz NO_DEPLOYMENT durumunu gösterir (imza kapalı).
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../../deployments/fuji.json");
const target = resolve(here, "../public/deployments/fuji.json");

if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log("deployments/fuji.json → public/deployments/fuji.json");
} else {
  rmSync(target, { force: true });
  console.log("deployments/fuji.json yok: arayüz NO_DEPLOYMENT durumunda açılır (imza kapalı).");
}

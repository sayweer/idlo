/**
 * Kayıt dosyası OKUMA (SPEC §11.2). Saf ayrıştırma / oynatma `@pilot/shared` (weather/) içindedir;
 * shared G/Ç yapmadığı için dosya okuma burada kalır.
 */
import { readFile } from "node:fs/promises";
import { parseReplay, type Replay } from "@pilot/shared";

export async function readReplayFile(path: string): Promise<Replay> {
  return parseReplay(JSON.parse(await readFile(path, "utf8")));
}

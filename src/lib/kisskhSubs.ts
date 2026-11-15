/**
 * KissKH subtitle decryption, kept apart from the source module so the subtitle loader can use it
 * without pulling in the whole provider.
 *
 * Per `debakarr/kisskh-dl`, KissKH `.txt`/`.txt1` files keep SRT cue indices and timestamps in
 * plaintext while AES-128-CBC-encrypting each cue's text lines (key/IV below).
 */
const KISSKH_SUB_KEY = "8056483646328763";
const KISSKH_SUB_IV = "6852612370185273";

let cachedSubKeyPromise: Promise<CryptoKey> | null = null;
const KISSKH_IV_BYTES = new TextEncoder().encode(KISSKH_SUB_IV);

function getKisskhSubKey(): Promise<CryptoKey> {
  if (!cachedSubKeyPromise) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return Promise.reject(new Error("WebCrypto subtle API unavailable"));
    const keyBytes = new TextEncoder().encode(KISSKH_SUB_KEY);
    cachedSubKeyPromise = subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  }
  return cachedSubKeyPromise;
}

function kkBase64ToBytes(raw: string): Uint8Array<ArrayBuffer> | null {
  const clean = raw.trim();
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}


/** Decrypt a single Base64-encoded AES-128-CBC KissKH subtitle block (PKCS#7 + trailing NUL trim). */
export async function decryptKisskhBlock(b64: string): Promise<string | null> {
  const cipher = kkBase64ToBytes(b64);
  if (!cipher || cipher.length < 16 || cipher.length % 16 !== 0) return null;
  try {
    const key = await getKisskhSubKey();
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: KISSKH_IV_BYTES },
      key,
      cipher,
    );
    const bytes = new Uint8Array(plainBuf);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return null;
  }
}

/**
 * Decrypt a KissKH `.txt` / `.txt1` subtitle payload.
 * Per `debakarr/kisskh-dl`, KissKH `.txt`/`.txt1` files keep SRT cue indices and timestamps in
 * plaintext while AES-128-CBC-encrypting each cue's text lines. Also handles whole-payload
 * encrypted blobs and passes through unencrypted SRT/VTT unchanged.
 */
export async function decryptKisskhSubtitle(raw: string): Promise<{ text: string; decrypted: boolean }> {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return { text: normalized, decrypted: false };

  if (!normalized.includes("-->")) {
    const whole = await decryptKisskhBlock(normalized.replace(/\s+/g, ""));
    if (whole && whole.trim()) {
      return { text: whole.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), decrypted: true };
    }
    return { text: normalized, decrypted: false };
  }

  const lines = normalized.split("\n");
  const out: string[] = [];
  let decryptedCount = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    if (!line.includes("-->")) continue;

    const cueLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      cueLines.push(lines[i]);
      i++;
    }

    if (cueLines.length > 0) {
      let cueDecrypted = 0;
      const decodedLines = await Promise.all(
        cueLines.map(async (cl) => {
          const dec = await decryptKisskhBlock(cl);
          if (dec !== null) {
            cueDecrypted++;
            return dec;
          }
          return cl;
        }),
      );

      if (cueDecrypted > 0) {
        decryptedCount += cueDecrypted;
        out.push(...decodedLines);
      } else if (cueLines.length > 1) {
        const joined = await decryptKisskhBlock(cueLines.map((l) => l.trim()).join(""));
        if (joined !== null) {
          decryptedCount++;
          out.push(joined);
        } else {
          out.push(...cueLines);
        }
      } else {
        out.push(...cueLines);
      }
    }

    if (i < lines.length && lines[i].trim() === "") {
      out.push(lines[i]);
      i++;
    }
  }

  return { text: out.join("\n"), decrypted: decryptedCount > 0 };
}

/** Subtitle files KissKH serves encrypted (`.txt`, `.txt1`, ...). */
export function isEncryptedSubCandidateUrl(url: string): boolean {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  return (
    clean.endsWith(".txt")
    || clean.endsWith(".txt1")
    || clean.endsWith(".txt2")
    || clean.endsWith(".srt1")
    || clean.endsWith(".srt2")
  );
}

// A double for Clerk session tokens: an RSA-2048 keypair generated at test time
// signs RS256 JWTs, so no private key is committed and Clerk is never called.
// `forgedFor` signs with an unrelated keypair; without that test, a verifier
// that accepted every token would pass every other test.

const RSA_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(RSA_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64UrlEncode(data: Uint8Array): string {
  return arrayBufferToBase64(data.buffer as ArrayBuffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function exportSpkiPem(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("exportKey('spki', ...) did not return an ArrayBuffer");
  }
  const base64 = arrayBufferToBase64(exported);
  const lines = base64.match(/.{1,64}/g);
  const body = lines === null ? base64 : lines.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

async function signRs256(
  privateKey: CryptoKey,
  userId: string,
  origin: string,
  expiresInSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    sub: userId,
    sid: `sess_${userId}`,
    azp: origin,
    iat: now,
    nbf: now - 5,
    exp: now + expiresInSeconds,
  };
  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export type ClerkDouble = {
  readonly jwtKey: string;
  requestAs(userId: string, url: string, init?: RequestInit): Promise<Request>;
  forgedFor(userId: string, url: string): Promise<string>;
  expiredFor(userId: string, url: string): Promise<string>;
};

export async function createClerkDouble(): Promise<ClerkDouble> {
  const primary = await generateRsaKeyPair();
  const forger = await generateRsaKeyPair();
  const jwtKey = await exportSpkiPem(primary.publicKey);

  return {
    jwtKey,
    async requestAs(userId: string, url: string, init?: RequestInit): Promise<Request> {
      const token = await signRs256(primary.privateKey, userId, new URL(url).origin, 3600);
      return new Request(url, { ...init, headers: { cookie: `__session=${token}` } });
    },
    async forgedFor(userId: string, url: string): Promise<string> {
      return signRs256(forger.privateKey, userId, new URL(url).origin, 3600);
    },
    async expiredFor(userId: string, url: string): Promise<string> {
      return signRs256(primary.privateKey, userId, new URL(url).origin, -3600);
    },
  };
}

// Short-lived app session tokens: base64url(JSON claims) + "." + base64url(HMAC-SHA256).
// The Mini App sends it as `Authorization: Bearer <token>`.

import { base64UrlToBytes, bytesToBase64Url, encoder } from "./crypto.ts";
import { HttpError } from "./http.ts";

export interface TokenClaims {
  uid: string;
  exp: number;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyToken(token: string, secret: string, nowSeconds: number): Promise<TokenClaims> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) throw new HttpError(401, "TOKEN_INVALID");

  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    base64UrlToBytes(signature),
    encoder.encode(payload),
  );
  if (!valid) throw new HttpError(401, "TOKEN_INVALID");

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    throw new HttpError(401, "TOKEN_INVALID");
  }
  const parsed = claims as Partial<TokenClaims>;
  if (typeof parsed.uid !== "string" || typeof parsed.exp !== "number") throw new HttpError(401, "TOKEN_INVALID");
  if (parsed.exp <= nowSeconds) throw new HttpError(401, "TOKEN_EXPIRED");
  return { uid: parsed.uid, exp: parsed.exp };
}

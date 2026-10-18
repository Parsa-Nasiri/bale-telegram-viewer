// Mini App initData validation.
//
// Algorithm used (Telegram Mini Apps scheme):
//   secret = HMAC-SHA256(key = "WebAppData", message = bot_token)
//   data_check_string = all fields except `hash`, as "key=value", sorted by key, joined with "\n"
//   expected = hex(HMAC-SHA256(key = secret, message = data_check_string))
//
// NOTE: Bale's Mini App documentation could not be read during the build. Before going live, confirm
// this scheme against docs.bale.ai/miniapp (sections on initData and validation). This file is the only
// place that needs to change if Bale differs.

import { bytesToHex, encoder, hmacSha256, timingSafeEqualString } from "./crypto.ts";
import { HttpError } from "./http.ts";

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface VerifiedInitData {
  user: InitDataUser;
  authDate: number;
}

const CLOCK_SKEW_SECONDS = 300;

function isUser(value: unknown): value is InitDataUser {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "number" &&
    Number.isSafeInteger((value as { id: number }).id)
  );
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  nowSeconds: number,
  maxAgeSeconds: number,
): Promise<VerifiedInitData> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError(401, "INIT_DATA_INVALID", "missing hash");

  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expected = bytesToHex(await hmacSha256(secret, dataCheckString(params)));
  if (!timingSafeEqualString(expected, hash.toLowerCase())) {
    throw new HttpError(401, "INIT_DATA_INVALID", "signature mismatch");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new HttpError(401, "INIT_DATA_INVALID", "missing auth_date");
  }
  if (nowSeconds - authDate > maxAgeSeconds) throw new HttpError(401, "INIT_DATA_EXPIRED");
  if (authDate - nowSeconds > CLOCK_SKEW_SECONDS) throw new HttpError(401, "INIT_DATA_INVALID", "future auth_date");

  const rawUser = params.get("user");
  if (!rawUser) throw new HttpError(401, "INIT_DATA_INVALID", "missing user");
  let user: unknown;
  try {
    user = JSON.parse(rawUser);
  } catch {
    throw new HttpError(401, "INIT_DATA_INVALID", "user is not JSON");
  }
  if (!isUser(user)) throw new HttpError(401, "INIT_DATA_INVALID", "user has no id");
  return { user, authDate };
}

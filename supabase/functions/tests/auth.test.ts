import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { bytesToBase64Url, encoder } from "../_shared/crypto.ts";
import { HttpError } from "../_shared/http.ts";
import { verifyInitData } from "../_shared/initdata.ts";
import { signToken, verifyToken } from "../_shared/token.ts";

const BOT = "123456:TEST-BOT-TOKEN";
const NOW = 1_800_000_000;

/**
 * Builds signed initData with node:crypto directly, so these tests check the implementation
 * against an independent computation of the same scheme.
 */
function signInitData(fields: Record<string, string>, botToken = BOT): URLSearchParams {
  const params = new URLSearchParams(fields);
  const check = [...Object.entries(fields)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params;
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW - 10),
    query_id: "AAE",
    user: JSON.stringify({ id: 42, first_name: "Test" }),
    ...overrides,
  };
}

async function assertRejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HttpError && err.code === code);
}

describe("verifyInitData", () => {
  it("accepts correctly signed, fresh initData and returns the user", async () => {
    const initData = signInitData(validFields()).toString();
    const verified = await verifyInitData(initData, BOT, NOW, 3600);
    assert.equal(verified.user.id, 42);
    assert.equal(verified.authDate, NOW - 10);
  });

  it("rejects data signed with a different bot token", async () => {
    const initData = signInitData(validFields(), "999:OTHER").toString();
    await assertRejectsWith(verifyInitData(initData, BOT, NOW, 3600), "INIT_DATA_INVALID");
  });

  it("rejects data whose user field was changed after signing", async () => {
    const params = signInitData(validFields());
    params.set("user", JSON.stringify({ id: 43 }));
    await assertRejectsWith(verifyInitData(params.toString(), BOT, NOW, 3600), "INIT_DATA_INVALID");
  });

  it("rejects data older than the maximum age", async () => {
    const initData = signInitData(validFields({ auth_date: String(NOW - 7200) })).toString();
    await assertRejectsWith(verifyInitData(initData, BOT, NOW, 3600), "INIT_DATA_EXPIRED");
  });

  it("rejects an auth_date far in the future", async () => {
    const initData = signInitData(validFields({ auth_date: String(NOW + 3600) })).toString();
    await assertRejectsWith(verifyInitData(initData, BOT, NOW, 3600), "INIT_DATA_INVALID");
  });

  it("rejects input without a hash", async () => {
    await assertRejectsWith(verifyInitData("auth_date=1&user=%7B%7D", BOT, NOW, 3600), "INIT_DATA_INVALID");
  });
});

describe("app tokens", () => {
  const secret = "s".repeat(40);

  it("round-trips the user id and expiry", async () => {
    const token = await signToken({ uid: "user-1", exp: NOW + 60 }, secret);
    const claims = await verifyToken(token, secret, NOW);
    assert.deepEqual(claims, { uid: "user-1", exp: NOW + 60 });
  });

  it("rejects expired tokens", async () => {
    const token = await signToken({ uid: "user-1", exp: NOW - 1 }, secret);
    await assertRejectsWith(verifyToken(token, secret, NOW), "TOKEN_EXPIRED");
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signToken({ uid: "user-1", exp: NOW + 60 }, "x".repeat(40));
    await assertRejectsWith(verifyToken(token, secret, NOW), "TOKEN_INVALID");
  });

  it("rejects a token whose payload was altered", async () => {
    const token = await signToken({ uid: "user-1", exp: NOW + 60 }, secret);
    const [, signature] = token.split(".");
    const forged = bytesToBase64Url(encoder.encode(JSON.stringify({ uid: "admin", exp: NOW + 60 })));
    await assertRejectsWith(verifyToken(`${forged}.${signature}`, secret, NOW), "TOKEN_INVALID");
  });

  it("rejects malformed tokens", async () => {
    await assertRejectsWith(verifyToken("not-a-token", secret, NOW), "TOKEN_INVALID");
    await assertRejectsWith(verifyToken("a.b.c", secret, NOW), "TOKEN_INVALID");
  });
});

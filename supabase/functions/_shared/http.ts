// HTTP helpers: errors with stable codes, JSON responses, and CORS (open by default; see config.ts).

// Written without constructor parameter properties so the same file runs under Node's type stripping (tests).
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
  if (allowedOrigins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: unknown, headers: Record<string, string>): Response {
  if (err instanceof HttpError) {
    return jsonResponse({ error: { code: err.code, message: err.message } }, err.status, headers);
  }
  // Log the type only. Messages can contain request data.
  console.error("unhandled error", err instanceof Error ? err.name : "unknown");
  return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "internal error" } }, 500, headers);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await req.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through to the typed error below
  }
  throw new HttpError(400, "BAD_JSON", "expected a JSON object body");
}

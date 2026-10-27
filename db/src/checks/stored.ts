import { decryptSecret, encryptSecret } from "../crypto.js";
import type { ApiRequestSpec, BodyType, HttpMethod } from "./api.js";
import type { Rule } from "./rules.js";

export interface StoredHeader {
  name: string;
  value: string;
  // Shown masked in the app, and never sent back to the browser.
  secret: boolean;
}

// Headers are stored encrypted as a whole: which ones are secret is itself a hint.
export function sealHeaders(headers: StoredHeader[], key: Buffer): string | null {
  return headers.length === 0 ? null : encryptSecret(JSON.stringify(headers), key);
}

export function openHeaders(sealed: string | null, key: Buffer): StoredHeader[] {
  return sealed ? (JSON.parse(decryptSecret(sealed, key)) as StoredHeader[]) : [];
}

// An api_requests row, as far as a check needs it.
export interface StoredRequest {
  method: HttpMethod;
  // Sealed: see sealHeaders.
  headers: string | null;
  bodyType: BodyType;
  body: string | null;
  expectedStatus: string;
}

// An API monitor's stored settings, ready for checkApi.
export function toApiSpec(
  url: string,
  request: StoredRequest,
  assertions: Rule[],
  key: Buffer,
): ApiRequestSpec {
  return {
    url,
    method: request.method,
    headers: openHeaders(request.headers, key).map(({ name, value }) => ({ name, value })),
    bodyType: request.bodyType,
    body: request.body,
    expectedStatus: request.expectedStatus,
    rules: assertions.map(({ path, operator, expected }) => ({ path, operator, expected })),
  };
}

import { PrismaClient } from "@lanternly/db";
import type { Response } from "supertest";
import { createApp } from "../app.js";
import type { Env } from "../env.js";
import { TEST_DATABASE_URL } from "./database.js";

export const testEnv: Env = {
  NODE_ENV: "test",
  API_PORT: 0,
  DATABASE_URL: TEST_DATABASE_URL,
  WEB_ORIGIN: "http://localhost:5173",
  JWT_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  TRUST_PROXY: 0,
  AUTH_RATE_LIMIT_PER_MINUTE: 1000,
};

export const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });

// Every table hangs off users, so truncating it with CASCADE empties them all.
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
}

export function makeApp(env: Partial<Env> = {}) {
  return createApp({ env: { ...testEnv, ...env }, prisma });
}

// Pulls the refresh cookie out of a response, as a browser would store it.
export function refreshCookie(res: Response): string | undefined {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith("lanternly_refresh="));
}

export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

export const GOOD_PASSWORD = "amber-lantern-over-the-harbour";

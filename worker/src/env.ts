import { z } from "zod";

// Checked once at start-up, like the API's, so a typo stops the worker immediately.
const schema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  // Links in alert emails point here.
  WEB_ORIGIN: z.url(),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Lanternly <alerts@lanternly.local>"),
  // The API's key, to read the headers it stored encrypted for API monitors.
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // Checks mostly wait on the network, so many can run at once.
  CHECK_CONCURRENCY: z.coerce.number().int().positive().default(20),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${problems.join("\n")}`);
  }
  return result.data;
}

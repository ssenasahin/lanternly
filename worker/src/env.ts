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

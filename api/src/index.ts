import { prisma } from "@lanternly/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { smtpMailer } from "./mailer.js";

const env = loadEnv();
const mailer = smtpMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER,
  pass: env.SMTP_PASS,
  from: env.MAIL_FROM,
});
const app = createApp({ env, prisma, mailer });

const server = app.listen(env.API_PORT, () => {
  console.log(`lanternly api listening on http://localhost:${env.API_PORT}`);
});

// Finish in-flight requests and close database connections before exiting.
function shutdown() {
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

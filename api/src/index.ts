import { prisma } from "@lanternly/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = createApp({ env, prisma });

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

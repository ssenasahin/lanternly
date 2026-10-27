import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { decryptSecret, encryptSecret, parseEncryptionKey } from "./crypto.js";

// One client per process: each PrismaClient holds its own connection pool.
export const prisma = new PrismaClient();

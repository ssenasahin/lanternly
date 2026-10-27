import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { decryptSecret, encryptSecret, parseEncryptionKey } from "./crypto.js";
export {
  isPublicAddress,
  resolveHost,
  resolvePublicHost,
  UnsafeTargetError,
  type ResolveHost,
} from "./network.js";

// One client per process: each PrismaClient holds its own connection pool.
export const prisma = new PrismaClient();

import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

// One client per process: each PrismaClient holds its own connection pool.
export const prisma = new PrismaClient();

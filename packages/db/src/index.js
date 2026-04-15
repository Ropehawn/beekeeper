const { PrismaClient } = require("@prisma/client");

const globalForPrisma = globalThis;

const db =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = db;

module.exports = { db, prisma: db, PrismaClient };
// Re-export all Prisma types
Object.assign(module.exports, require("@prisma/client"));

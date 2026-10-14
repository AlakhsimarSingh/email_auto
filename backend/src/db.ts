import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export function disconnectDb() {
  return prisma.$disconnect();
}

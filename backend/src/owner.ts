import { env } from './env.js';
import { prisma } from './db.js';

export async function ensureConfiguredOwner() {
  const email = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('OWNER_EMAIL must be configured with a valid email address');
  }
  const existingOwner = await prisma.adminUser.findFirst({ where: { role: 'owner' } });
  if (existingOwner && existingOwner.email !== email) {
    throw new Error('An owner account already exists and does not match OWNER_EMAIL; align the configuration before starting the backend. No owner account was changed.');
  }
  if (existingOwner) return existingOwner;
  return prisma.adminUser.upsert({
    where: { email },
    update: { role: 'owner' },
    create: { email, role: 'owner' },
  });
}

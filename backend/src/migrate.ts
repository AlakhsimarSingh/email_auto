import { env } from './env.js';
import { disconnectDb, prisma } from './db.js';
import { ensureConfiguredOwner } from './owner.js';

try {
  await ensureConfiguredOwner();
  if (!await prisma.campaign.count()) {
    await prisma.campaign.create({
      data: { name: 'Dentists - Toronto', niche: 'dentist', city: 'Toronto', country: 'CA', osmFilter: 'amenity=dentist' },
    });
  }
  console.log('migrated');
} finally {
  await disconnectDb();
}

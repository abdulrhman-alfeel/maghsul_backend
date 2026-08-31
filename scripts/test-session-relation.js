import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Testing Session Replacement Relation...');
  
  // 1. Get any Identity
  const identity = await prisma.identity.findFirst();
  if (!identity) throw new Error('No identity found in seed data');

  // 2. Create Provisional Session
  const provisional = await prisma.session.create({
    data: {
      identityId: identity.id,
      sessionType: 'provisional',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    }
  });
  console.log('Created Provisional Session:', provisional.id);

  // 3. Create Operational Session replacing it
  const operational = await prisma.session.create({
    data: {
      identityId: identity.id,
      sessionType: 'operational',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  });
  console.log('Created Operational Session:', operational.id);

  // 4. Update Provisional to link to Operational
  const updatedProvisional = await prisma.session.update({
    where: { id: provisional.id },
    data: {
      replacedBySessionId: operational.id,
      isRevoked: true,
      revokedAt: new Date(),
      revokedReason: 'upgraded_to_operational'
    },
    include: { replacedBySession: true }
  });

  console.log('Provisional replaced by:', updatedProvisional.replacedBySession.id);

  // 5. Check backwards relation
  const opWithReplaces = await prisma.session.findUnique({
    where: { id: operational.id },
    include: { replacesSession: true }
  });

  console.log('Operational replaces:', opWithReplaces.replacesSession.id);

  // 6. Test uniqueness (should fail if we try to replace another session with the same operational session)
  const provisional2 = await prisma.session.create({
    data: {
      identityId: identity.id,
      sessionType: 'provisional',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    }
  });

  try {
    await prisma.session.update({
      where: { id: provisional2.id },
      data: { replacedBySessionId: operational.id }
    });
    console.error('FAIL: Uniqueness constraint did not block duplicate replacement');
  } catch (e) {
    if (e.code === 'P2002') {
      console.log('SUCCESS: Unique constraint enforced successfully on replacedBySessionId');
    } else {
      console.error('Unexpected error:', e);
    }
  }

  // Cleanup
  await prisma.session.delete({ where: { id: provisional2.id } });
  await prisma.session.delete({ where: { id: provisional.id } });
  await prisma.session.delete({ where: { id: operational.id } });
  console.log('Cleanup complete. Original data unaffected.');
}

main().catch(console.error).finally(() => prisma.$disconnect());

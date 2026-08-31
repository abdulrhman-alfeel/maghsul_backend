import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedTestMigrationData() {
  await prisma.$executeRaw`TRUNCATE TABLE "StaffInvitation" CASCADE;`;
  await prisma.$executeRaw`TRUNCATE TABLE "StaffMembership" CASCADE;`;
  await prisma.$executeRaw`TRUNCATE TABLE "Identity" CASCADE;`;
  await prisma.$executeRaw`TRUNCATE TABLE "Washer" CASCADE;`;

  console.log('Inserting mock data for migration test...');

  const identity = await prisma.identity.create({
    data: {
      phone: '555123456',
      status: 'active'
    }
  });

  const washer = await prisma.washer.create({
    data: {
      name: 'Migration Test Washer',
      status: 'active'
    }
  });

  const inviter = await prisma.staffMembership.create({
    data: {
      identityId: identity.id,
      washerId: washer.id,
      role: 'washer_owner',
      status: 'active',
      hasFullWasherAccess: true
    }
  });

  // 1. Valid invitation
  await prisma.staffInvitation.create({
    data: {
      washerId: washer.id,
      phone: '500111222',
      proposedRole: 'worker',
      invitedByIdentityId: identity.id,
      invitedByStaffMembershipId: inviter.id,
      tokenHash: 'token1',
      expiresAt: new Date(Date.now() + 86400000),
      status: 'pending'
    }
  });

  // 2. Invitation without invitedByStaffMembershipId
  await prisma.staffInvitation.create({
    data: {
      washerId: washer.id,
      phone: '500333444',
      proposedRole: 'driver',
      invitedByIdentityId: identity.id,
      // invitedByStaffMembershipId IS NULL
      tokenHash: 'token2',
      expiresAt: new Date(Date.now() + 86400000),
      status: 'pending'
    }
  });

  // 3. Two pending invitations for the same washer and phone (different formats)
  // Older one
  await prisma.staffInvitation.create({
    data: {
      washerId: washer.id,
      phone: '+966500555666',
      proposedRole: 'worker',
      invitedByIdentityId: identity.id,
      invitedByStaffMembershipId: inviter.id,
      tokenHash: 'token3_older',
      expiresAt: new Date(Date.now() + 86400000),
      status: 'pending',
      createdAt: new Date(Date.now() - 10000)
    }
  });

  // Newer one
  await prisma.staffInvitation.create({
    data: {
      washerId: washer.id,
      phone: '0500555666',
      proposedRole: 'worker',
      invitedByIdentityId: identity.id,
      invitedByStaffMembershipId: inviter.id,
      tokenHash: 'token4_newer',
      expiresAt: new Date(Date.now() + 86400000),
      status: 'pending',
      createdAt: new Date()
    }
  });

  console.log('Mock data inserted successfully.');
  await prisma.$disconnect();
}

seedTestMigrationData().catch(console.error);

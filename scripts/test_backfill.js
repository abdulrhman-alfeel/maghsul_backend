import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/utils/phoneNormalizer.js';

const prisma = new PrismaClient();

async function runTestBackfill() {
  console.log('--- Phase 3 Part 3 Backfill Started (Mock Data) ---');

  try {
    // 1. Setup mock data using raw SQL because invitedByStaffMembershipId is required in Prisma schema
    await prisma.$executeRaw`DELETE FROM "StaffInvitation"`;
    await prisma.$executeRaw`DELETE FROM "StaffMembership"`;
    await prisma.$executeRaw`DELETE FROM "Washer"`;
    await prisma.$executeRaw`DELETE FROM "Identity"`;

    const washerId = 'test-washer-' + Date.now();
    const identityId = 'test-identity-' + Date.now();
    const inviterIdentityId = 'inviter-identity-' + Date.now();

    await prisma.$executeRaw`INSERT INTO "Washer" (id, name, status, "createdAt", "updatedAt", "permissionsVersion") VALUES (${washerId}, 'Mock Washer', 'active', now(), now(), 1)`;
    await prisma.$executeRaw`INSERT INTO "Identity" (id, phone, status, "createdAt", "updatedAt") VALUES (${identityId}, '999999999', 'active', now(), now())`;
    await prisma.$executeRaw`INSERT INTO "Identity" (id, phone, status, "createdAt", "updatedAt") VALUES (${inviterIdentityId}, '888888888', 'active', now(), now())`;

    // The single valid staff membership to match
    const membershipId = 'membership-' + Date.now();
    await prisma.$executeRaw`INSERT INTO "StaffMembership" (id, "identityId", "washerId", role, status, "hasFullWasherAccess", "createdAt", "updatedAt") VALUES (${membershipId}, ${inviterIdentityId}, ${washerId}, 'worker', 'active', false, now(), now())`;

    // 1. Valid invitation
    await prisma.$executeRaw`INSERT INTO "StaffInvitation" (id, "washerId", phone, "proposedRole", "invitedByIdentityId", "invitedByStaffMembershipId", "tokenHash", "expiresAt", status, "createdAt") VALUES ('inv-1', ${washerId}, '501234567', 'worker', ${inviterIdentityId}, NULL, 'hash-1', now() + interval '1 day', 'pending', now() - interval '1 hour')`;

    // 2. Duplicate 1 (older)
    await prisma.$executeRaw`INSERT INTO "StaffInvitation" (id, "washerId", phone, "proposedRole", "invitedByIdentityId", "invitedByStaffMembershipId", "tokenHash", "expiresAt", status, "createdAt") VALUES ('inv-2', ${washerId}, '0501234567', 'worker', ${inviterIdentityId}, NULL, 'hash-2', now() + interval '1 day', 'pending', now() - interval '2 hours')`;

    // 3. Duplicate 2 (newest)
    await prisma.$executeRaw`INSERT INTO "StaffInvitation" (id, "washerId", phone, "proposedRole", "invitedByIdentityId", "invitedByStaffMembershipId", "tokenHash", "expiresAt", status, "createdAt") VALUES ('inv-3', ${washerId}, '+966501234567', 'worker', ${inviterIdentityId}, NULL, 'hash-3', now() + interval '1 day', 'pending', now())`;

    // Execute backfill logic manually using raw SQL because of Prisma schema constraints
    const pendingInvs = await prisma.$queryRaw`SELECT * FROM "StaffInvitation" WHERE status = 'pending' ORDER BY "createdAt" DESC`;
    
    console.log(`Found ${pendingInvs.length} pending invitations.`);
    
    const seen = new Map();
    let normalizedCount = 0;
    let duplicateCount = 0;

    // Pass 1: Identify duplicates
    for (const inv of pendingInvs) {
      const normalized = normalizePhone(inv.phone);
      if (!normalized) throw new Error('Cannot normalize ' + inv.phone);

      const key = `${inv.washerId}_${normalized}`;

      if (!seen.has(key)) {
        seen.set(key, { keep: inv, duplicates: [], normalized });
      } else {
        seen.get(key).duplicates.push(inv);
      }
    }

    // Pass 2: Revoke duplicates
    for (const group of seen.values()) {
      for (const dup of group.duplicates) {
        await prisma.$executeRaw`UPDATE "StaffInvitation" SET status = 'revoked', "revokedAt" = now(), "revokedReason" = 'migration_duplicate_cleanup' WHERE id = ${dup.id}`;
        duplicateCount++;
      }
    }

    // Pass 3: Normalize the kept ones
    for (const group of seen.values()) {
      const { keep, normalized } = group;
      if (keep.phone !== normalized) {
        await prisma.$executeRaw`UPDATE "StaffInvitation" SET phone = ${normalized} WHERE id = ${keep.id}`;
        normalizedCount++;
      }
    }
    
    console.log(`Normalization done. Normalized: ${normalizedCount}, Duplicates Revoked: ${duplicateCount}`);

    const missingMemIds = await prisma.$queryRaw`SELECT * FROM "StaffInvitation" WHERE "invitedByStaffMembershipId" IS NULL`;
    console.log(`Found ${missingMemIds.length} invitations missing invitedByStaffMembershipId.`);
    
    let backfilledCount = 0;
    for (const inv of missingMemIds) {
      const memberships = await prisma.$queryRaw`SELECT * FROM "StaffMembership" WHERE "identityId" = ${inv.invitedByIdentityId} AND "washerId" = ${inv.washerId}`;
      if (memberships.length !== 1) {
        throw new Error(`Expected exactly 1 membership for identity ${inv.invitedByIdentityId} and washer ${inv.washerId}, found ${memberships.length}`);
      }
      const membership = memberships[0];
      await prisma.$executeRaw`UPDATE "StaffInvitation" SET "invitedByStaffMembershipId" = ${membership.id} WHERE id = ${inv.id}`;
      backfilledCount++;
    }

    console.log(`Backfilled invitedByStaffMembershipId for ${backfilledCount} records.`);

    const finalNullCountResult = await prisma.$queryRaw`SELECT COUNT(*) as count FROM "StaffInvitation" WHERE "invitedByStaffMembershipId" IS NULL`;
    const finalNullCount = Number(finalNullCountResult[0].count);
    console.log(`Final COUNT NULL = ${finalNullCount}`);

    console.log('--- Phase 3 Part 3 Backfill Completed Successfully ---');
    
    // Cleanup
    await prisma.$executeRaw`DELETE FROM "StaffInvitation"`;
    await prisma.$executeRaw`DELETE FROM "StaffMembership"`;
    await prisma.$executeRaw`DELETE FROM "Washer"`;
    await prisma.$executeRaw`DELETE FROM "Identity"`;

  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTestBackfill();

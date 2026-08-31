import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' }); // Using test DB by default for testing
import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/utils/phoneNormalizer.js';

const prisma = new PrismaClient();

async function runBackfill() {
  console.log('--- Phase 3 Part 3 Backfill Started ---');

  try {
    // 1. Phone Normalization & Duplicate Resolution
    const invitations = await prisma.staffInvitation.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' }
    });

    console.log(`Found ${invitations.length} pending invitations.`);
    
    // washerId_phone -> invitation object
    const seen = new Map();
    let normalizedCount = 0;
    let duplicateCount = 0;

    for (const inv of invitations) {
      const normalized = normalizePhone(inv.phone);
      if (!normalized) {
        throw new Error(`Cannot normalize phone for invitation ${inv.id}: ${inv.phone}`);
      }

      const key = `${inv.washerId}_${normalized}`;

      if (seen.has(key)) {
        // This is an older duplicate because we ordered by createdAt DESC
        await prisma.staffInvitation.update({
          where: { id: inv.id },
          data: {
            status: 'revoked',
            revokedAt: new Date(),
            revokedReason: 'migration_duplicate_cleanup',
            phone: normalized
          }
        });
        duplicateCount++;
      } else {
        seen.set(key, inv);
        if (inv.phone !== normalized) {
          await prisma.staffInvitation.update({
            where: { id: inv.id },
            data: { phone: normalized }
          });
          normalizedCount++;
        }
      }
    }
    
    // Also normalize non-pending to maintain data consistency
    const otherInvitations = await prisma.staffInvitation.findMany({
      where: { status: { not: 'pending' } }
    });
    for (const inv of otherInvitations) {
      const normalized = normalizePhone(inv.phone);
      if (!normalized) {
        throw new Error(`Cannot normalize phone for invitation ${inv.id}: ${inv.phone}`);
      }
      if (inv.phone !== normalized) {
        await prisma.staffInvitation.update({
          where: { id: inv.id },
          data: { phone: normalized }
        });
        normalizedCount++;
      }
    }

    console.log(`Normalization done. Normalized: ${normalizedCount}, Duplicates Revoked: ${duplicateCount}`);

    // 2. Backfill invitedByStaffMembershipId
    const missingMemIds = await prisma.staffInvitation.findMany({
      where: { invitedByStaffMembershipId: null }
    });

    console.log(`Found ${missingMemIds.length} invitations missing invitedByStaffMembershipId.`);
    
    let backfilledCount = 0;
    for (const inv of missingMemIds) {
      // Find the membership for the inviter
      const membership = await prisma.staffMembership.findFirst({
        where: {
          identityId: inv.invitedByIdentityId,
          washerId: inv.washerId
        }
      });

      if (!membership) {
        throw new Error(`No staff membership found for identityId ${inv.invitedByIdentityId} in washer ${inv.washerId}. Cannot backfill.`);
      }

      await prisma.staffInvitation.update({
        where: { id: inv.id },
        data: { invitedByStaffMembershipId: membership.id }
      });
      backfilledCount++;
    }

    console.log(`Backfilled invitedByStaffMembershipId for ${backfilledCount} records.`);

    // 3. Final NULL count check
    const finalNullCount = await prisma.staffInvitation.count({
      where: { invitedByStaffMembershipId: null }
    });
    console.log(`Final COUNT NULL = ${finalNullCount}`);

    if (finalNullCount > 0) {
      throw new Error('There are still NULL values in invitedByStaffMembershipId');
    }

    console.log('--- Phase 3 Part 3 Backfill Completed Successfully ---');
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runBackfill();

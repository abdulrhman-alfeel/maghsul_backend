import prisma from '../../../config/db.js';
import redis from '../../../config/redis.js';

export class PermissionService {
  /**
   * Resolve permissions for a staff member, applying Role and Branch overrides.
   * Caches results using washer's permissionsVersion.
   * @param {string} washerId 
   * @param {string} staffMembershipId 
   * @param {string|null} branchId 
   * @returns {Promise<Set<string>>}
   */
  static async resolvePermissions(washerId, staffMembershipId, branchId = null) {
    try {
      const washer = await prisma.washer.findUnique({
        where: { id: washerId },
        select: { permissionsVersion: true }
      });

      if (!washer) {
        return new Set(); // Fail closed
      }

      const version = washer.permissionsVersion;
      const branchKey = branchId || 'global';
      const cacheKey = `washer-perms:${washerId}:mem:${staffMembershipId}:branch:${branchKey}:v${version}`;

      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return new Set(JSON.parse(cached));
        }
      } catch (redisErr) {
        // Fallback to DB if Redis fails, just log and continue
        console.error('Redis failure in resolvePermissions:', redisErr.message);
      }

      // DB Fallback / Cache Miss
      const membership = await prisma.staffMembership.findUnique({
        where: { id: staffMembershipId },
        select: { role: true, hasFullWasherAccess: true, washerId: true, status: true }
      });

      if (!membership || membership.washerId !== washerId || membership.status !== 'active') {
        return new Set();
      }

      // 1. Get role permissions
      const rolePerms = await prisma.rolePermission.findMany({
        where: { role: membership.role },
        include: { permission: true }
      });

      const allowedPermissions = new Set();
      for (const rp of rolePerms) {
        if (rp.permission.isActive) {
          allowedPermissions.add(rp.permission.code);
        }
      }

      // 2. Apply branch overrides (if branchId is provided)
      if (branchId) {
        const branchAccess = await prisma.branchAccess.findFirst({
          where: { staffMembershipId, branchId }
        });

        if (branchAccess) {
          const overrides = await prisma.branchPermissionOverride.findMany({
            where: { branchAccessId: branchAccess.id },
            include: { permission: true }
          });

          for (const override of overrides) {
            // Branch overrides can ONLY restrict (deny) permissions.
            // inherit is the default behavior if not overridden.
            // We do NOT allow "allow" to elevate privileges above role defaults.
            if (override.effect === 'deny') {
              allowedPermissions.delete(override.permission.code);
            }
          }
        } else if (!membership.hasFullWasherAccess) {
          // If no branch access and not full washer access, they have no permissions for this branch
          return new Set();
        }
      }

      const permsArray = Array.from(allowedPermissions);

      try {
        await redis.setex(cacheKey, 3600, JSON.stringify(permsArray));
      } catch (redisErr) {
        console.error('Redis failure during set in resolvePermissions:', redisErr.message);
      }

      return allowedPermissions;
    } catch (err) {
      console.error('Fatal DB error in resolvePermissions:', err.message);
      // DB + Redis Fail = Fail Closed
      const error = new Error('SERVICE_UNAVAILABLE');
      error.status = 503;
      throw error;
    }
  }

  /**
   * Invalidates permissions cache by incrementing permissionsVersion
   * Should be called within a Prisma transaction whenever roles or branch overrides change.
   */
  static async incrementPermissionsVersion(tx, washerId) {
    return await tx.washer.update({
      where: { id: washerId },
      data: { permissionsVersion: { increment: 1 } }
    });
  }
}

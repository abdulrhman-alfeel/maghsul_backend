import { PermissionService } from '../modules/auth/services/permission.service.js';
import ApiError from '../helpers/apiError.js';
import prisma from '../config/db.js';

/**
 * Middleware to check if the current staff member has a specific permission.
 * MUST be placed after contextGuard and requireStaffSession middlewares.
 * 
 * @param {string} permissionKey The permission code to check (e.g. 'staff.invite')
 */
export function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const ctx = req.authContext;
      
      // Safety check: ensure requireStaffSession was called
      if (!ctx || ctx.sessionType !== 'operational' || !ctx.staffMembershipId || !ctx.branchId) {
        throw new ApiError(403, 'STAFF_SESSION_REQUIRED', 'هذا الإجراء يتطلب جلسة موظف تشغيلية بفرع محدد');
      }

      const permissions = await PermissionService.resolvePermissions(
        ctx.washerId,
        ctx.staffMembershipId,
        ctx.branchId
      );

      if (!permissions.has(permissionKey)) {
        // Log sensitive security events if needed. We don't audit log all 403s, 
        // but crossing Washer/Branch boundaries or failing high-level auth like invites might be logged.
        // For standard permission deny, just throw.
        throw new ApiError(403, 'PERMISSION_DENIED', 'ليس لديك الصلاحية المطلوبة للقيام بهذا الإجراء');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

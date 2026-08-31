import prisma from '../../../config/db.js';
import { OtpService } from '../services/otp.service.js';
import { SessionService } from '../services/session.service.js';
import ApiError from '../../../helpers/apiError.js';
import { normalizePhone } from '../../../utils/phoneNormalizer.js';
import { ok } from '../../../helpers/apiResponse.js';

/**
 * Staff Authentication Controller
 *
 * Staff routes do NOT use AppClientResolver.
 * OTP is scoped to (phone, purpose=login, appClientId=null) for staff.
 */
const StaffController = {

  /**
   * POST /api/auth/staff/send-otp
   *
   * Sends a staff login OTP. Does NOT reveal if the phone is registered.
   */
  async sendOtp(req, res) {
    const { phone } = req.body;

    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    // Staff OTP has no appClientId (null) — distinct from customer OTP
    await OtpService.sendOtp(normalized, 'login', null);

    // Unified response — do not reveal if phone has a staff account
    return ok(res, { sent: true }, 'إذا كان الرقم مسجلاً، سيصلك رمز التحقق');
  },

  /**
   * POST /api/auth/staff/verify-otp
   *
   * Verifies OTP then:
   * - Builds availableContexts from StaffMembership + BranchAccess.
   * - If exactly 1 context → Operational Session directly.
   * - If >1 contexts → Provisional Session + availableContexts list.
   */
  async verifyOtp(req, res) {
    const { phone, code } = req.body;

    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    // Staff OTP scoped to null appClientId
    await OtpService.verifyOtp(normalized, code, 'login', null);

    const identity = await prisma.identity.findUnique({
      where: { phone: normalized }
    });

    if (!identity) {
      throw new ApiError(403, 'STAFF_ACCESS_NOT_FOUND', 'لا يوجد حساب موظف مرتبط بهذا الرقم');
    }
    if (identity.status === 'deleted') {
      throw new ApiError(403, 'ACCOUNT_DELETED', 'تم حذف هذا الحساب نهائياً');
    }
    if (identity.status === 'suspended') {
      throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'الحساب موقوف');
    }

    // Fetch all active memberships with branch accesses
    const memberships = await prisma.staffMembership.findMany({
      where: { identityId: identity.id, status: 'active' },
      include: {
        washer: { select: { id: true, name: true, status: true } },
        branchAccesses: {
          include: {
            branch: { select: { id: true, name: true, status: true } }
          }
        }
      }
    });

    if (memberships.length === 0) {
      throw new ApiError(403, 'STAFF_ACCESS_NOT_FOUND', 'لا توجد عضويات موظف نشطة');
    }

    // Build available contexts
    const availableContexts = await _buildStaffContexts(memberships);

    if (availableContexts.length === 0) {
      throw new ApiError(403, 'ACTIVE_BRANCH_NOT_FOUND', 'لا توجد فروع نشطة متاحة');
    }

    // Single context → direct operational session
    if (availableContexts.length === 1) {
      const ctx = availableContexts[0];
      const result = await SessionService.createOperationalSession(identity.id, {
        washerId: ctx.washerId,
        branchId: ctx.branchId,
        staffMembershipId: ctx.staffMembershipId,
        // Removed hardcoded application bounds. Canonical scope is now inherited and revalidated by SessionService.
      });

      return ok(res, {
        sessionType: 'operational',
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        identity: { id: identity.id, name: identity.name }
      }, 'تم تسجيل الدخول بنجاح');
    }

    // Multiple contexts → provisional session + context list
    const result = await SessionService.createProvisionalSession(identity.id, {
      // Removed hardcoded application bounds. Canonical scope is now inherited and revalidated by SessionService.
    });

    return ok(res, {
      sessionType: 'provisional',
      accessToken: result.accessToken,
      availableContexts,
      identity: { id: identity.id, name: identity.name }
    }, 'يرجى اختيار السياق المناسب');
  },

  /**
   * POST /api/auth/staff/select-context
   *
   * Selects a specific context from a Provisional Session.
   * Requires contextGuard + requireProvisionalSession.
   * All context fields are verified against DB — never trusted from client.
   */
  async selectContext(req, res) {
    const { identityId, sessionId } = req.authContext;
    const { staffMembershipId, washerId, branchId } = req.body;

    await _validateAndCreateStaffSession(identityId, sessionId, { staffMembershipId, washerId, branchId });

    const result = await SessionService.createReplacementSession(sessionId, {
      washerId,
      branchId,
      staffMembershipId,
      // Removed hardcoded application bounds. Canonical scope is now inherited and revalidated by SessionService.
    });

    return ok(res, {
      sessionType: 'operational',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    }, 'تم اختيار السياق بنجاح');
  },

  /**
   * POST /api/auth/switch-context
   *
   * Switches context for an existing Staff Operational Session.
   * Requires contextGuard + requireOperationalSession + requireStaffSession.
   */
  async switchContext(req, res) {
    const { identityId, sessionId } = req.authContext;
    const { staffMembershipId, washerId, branchId } = req.body;

    await _validateAndCreateStaffSession(identityId, sessionId, { staffMembershipId, washerId, branchId });

    const result = await SessionService.createReplacementSession(sessionId, {
      washerId,
      branchId,
      staffMembershipId,
      // Removed hardcoded application bounds. Canonical scope is now inherited and revalidated by SessionService.
    });

    return ok(res, {
      sessionType: 'operational',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    }, 'تم تبديل السياق بنجاح');
  }
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds an array of available staff contexts from memberships.
 * Respects hasFullWasherAccess (all active branches) vs BranchAccess records.
 */
async function _buildStaffContexts(memberships) {
  const contexts = [];

  for (const membership of memberships) {
    if (membership.washer.status !== 'active') continue;

    if (membership.hasFullWasherAccess) {
      // All active branches under this washer
      const activeBranches = await prisma.branch.findMany({
        where: { washerId: membership.washerId, status: 'active' },
        select: { id: true, name: true }
      });
      for (const branch of activeBranches) {
        contexts.push({
          staffMembershipId: membership.id,
          washerId: membership.washerId,
          washerName: membership.washer.name,
          branchId: branch.id,
          branchName: branch.name,
          role: membership.role
        });
      }
    } else {
      // Only explicitly granted branches
      for (const access of membership.branchAccesses) {
        if (access.branch.status === 'active') {
          contexts.push({
            staffMembershipId: membership.id,
            washerId: membership.washerId,
            washerName: membership.washer.name,
            branchId: access.branch.id,
            branchName: access.branch.name,
            role: membership.role
          });
        }
      }
    }
  }

  return contexts;
}

/**
 * Validates the requested staff context against DB, then verifies access.
 * Throws ApiError if any check fails.
 */
async function _validateAndCreateStaffSession(identityId, sessionId, { staffMembershipId, washerId, branchId }) {
  if (!staffMembershipId || !washerId || !branchId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'staffMembershipId, washerId, and branchId are required');
  }

  // 1. StaffMembership belongs to this identity
  const membership = await prisma.staffMembership.findUnique({
    where: { id: staffMembershipId },
    include: {
      branchAccesses: { where: { branchId } }
    }
  });

  if (!membership) {
    throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND', 'العضوية غير موجودة');
  }
  if (membership.identityId !== identityId) {
    throw new ApiError(403, 'MEMBERSHIP_IDENTITY_MISMATCH', 'العضوية لا تعود لهذه الهوية');
  }
  if (membership.status !== 'active') {
    throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'العضوية غير نشطة');
  }
  if (membership.washerId !== washerId) {
    throw new ApiError(403, 'MEMBERSHIP_WASHER_MISMATCH', 'العضوية لا تعود لهذه المغسلة');
  }

  // 2. Branch belongs to same washer
  const branch = await prisma.branch.findUnique({
    where: { id: branchId }
  });
  if (!branch || branch.washerId !== washerId) {
    throw new ApiError(403, 'BRANCH_WASHER_MISMATCH', 'الفرع لا ينتمي لهذه المغسلة');
  }
  if (branch.status !== 'active') {
    throw new ApiError(403, 'BRANCH_NOT_ACTIVE', 'الفرع غير نشط');
  }

  // 3. Branch access: hasFullWasherAccess or explicit BranchAccess
  if (!membership.hasFullWasherAccess && membership.branchAccesses.length === 0) {
    throw new ApiError(403, 'BRANCH_ACCESS_DENIED', 'الموظف لا يملك صلاحية الوصول لهذا الفرع');
  }

  // 4. Washer must be active
  const washer = await prisma.washer.findUnique({ where: { id: washerId } });
  if (!washer || washer.status !== 'active') {
    throw new ApiError(403, 'WASHER_NOT_ACTIVE', 'المغسلة غير نشطة');
  }
}

export default StaffController;

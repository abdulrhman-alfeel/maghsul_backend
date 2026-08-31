import { TokenService } from '../modules/auth/services/token.service.js';
import { SessionService } from '../modules/auth/services/session.service.js';
import prisma from '../config/db.js';
import ApiError from '../helpers/apiError.js';

/**
 * ContextGuard - Core authentication middleware.
 *
 * 1. Reads Bearer Token from Authorization header.
 * 2. Verifies signature, algorithm (HS256), issuer, audience, and expiry.
 * 3. Fetches Session from DB and checks revocation state (Redis + DB).
 * 4. Performs strict field-level matching between JWT claims and Session record.
 *    null === null is enforced — missing field in JWT must match null in Session.
 * 5. Populates req.authContext.
 *
 * req.authContext = {
 *   identityId, sessionId, sessionType,
 *   washerId, branchId, staffMembershipId, customerMembershipId, userDeviceId
 * }
 */
export async function contextGuard(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      throw new ApiError(401, 'TOKEN_MISSING', 'Authorization header with Bearer token is required');
    }

    const rawToken = header.slice(7);
    const claims = TokenService.verifyAccessToken(rawToken);

    // Fetch Session from DB
    const session = await prisma.session.findUnique({
      where: { id: claims.sessionId }
    });

    if (!session) {
      throw new ApiError(401, 'SESSION_NOT_FOUND', 'Session does not exist');
    }

    // Check revocation state via Redis / DB
    const state = await SessionService.getSessionState(session.id);
    if (state === 'revoked' || session.isRevoked) {
      throw new ApiError(401, 'SESSION_REVOKED', 'الجلسة ملغاة');
    }

    // Check session expiry
    if (session.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'الجلسة منتهية الصلاحية');
    }

    // Strict field-level matching: JWT claims must match Session exactly.
    // null must equal null — "missing in JWT" is normalized to null for comparison.
    const claimWasherId         = claims.washerId          ?? null;
    const claimBranchId         = claims.branchId          ?? null;
    const claimStaffId          = claims.staffMembershipId ?? null;
    const claimCustomerId       = claims.customerMembershipId ?? null;
    const claimPurpose          = claims.purpose           ?? null;

    if (claims.identityId !== session.identityId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token identity does not match session');
    }
    if (claims.sessionType !== session.sessionType) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token session type does not match session');
    }
    if (claimPurpose !== session.purpose) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token purpose does not match session');
    }
    if (claimWasherId !== session.washerId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token washerId does not match session');
    }
    if (claimBranchId !== session.branchId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token branchId does not match session');
    }
    if (claimStaffId !== session.staffMembershipId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token staffMembershipId does not match session');
    }
    if (claimCustomerId !== session.customerMembershipId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token customerMembershipId does not match session');
    }

    req.authContext = {
      identityId:           session.identityId,
      sessionId:            session.id,
      sessionType:          session.sessionType,
      purpose:              session.purpose,
      washerId:             session.washerId,
      branchId:             session.branchId,
      staffMembershipId:    session.staffMembershipId,
      customerMembershipId: session.customerMembershipId,
      userDeviceId:         session.userDeviceId
    };

    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Session-type guards
// ---------------------------------------------------------------------------

/**
 * Requires the session to be of type 'provisional'.
 * Rejects operational sessions.
 */
export function requireProvisionalSession(req, res, next) {
  try {
    const ctx = req.authContext;
    if (!ctx || ctx.sessionType !== 'provisional') {
      throw new ApiError(403, 'PROVISIONAL_SESSION_REQUIRED', 'This endpoint requires a provisional session');
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires the session to be of type 'operational'.
 * Also validates Session Invariants:
 *   - Must have customerMembershipId OR staffMembershipId, not both.
 *   - Must have washerId.
 */
export function requireOperationalSession(req, res, next) {
  try {
    const ctx = req.authContext;
    if (!ctx || ctx.sessionType !== 'operational') {
      throw new ApiError(403, 'OPERATIONAL_SESSION_REQUIRED', 'This endpoint requires an operational session');
    }

    // Invariant: must have exactly one membership type
    if (ctx.customerMembershipId && ctx.staffMembershipId) {
      throw new ApiError(403, 'INVALID_SESSION_STATE', 'Session cannot carry both customer and staff membership');
    }
    if (!ctx.customerMembershipId && !ctx.staffMembershipId) {
      throw new ApiError(403, 'INVALID_SESSION_STATE', 'Operational session must carry either customer or staff membership');
    }
    if (!ctx.washerId) {
      throw new ApiError(403, 'INVALID_SESSION_STATE', 'Operational session must have a washerId');
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires a Customer Operational Session.
 * Validates CustomerMembership against DB:
 *   - exists, active, belongs to same identityId AND washerId.
 */
export async function requireCustomerSession(req, res, next) {
  try {
    const ctx = req.authContext;

    if (!ctx || !ctx.customerMembershipId) {
      throw new ApiError(403, 'CUSTOMER_SESSION_REQUIRED', 'This endpoint requires a customer session');
    }
    if (ctx.staffMembershipId) {
      throw new ApiError(403, 'INVALID_SESSION_STATE', 'Session carries a staff membership, not a customer membership');
    }

    const membership = await prisma.customerMembership.findUnique({
      where: { id: ctx.customerMembershipId }
    });

    if (!membership) {
      throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND', 'Customer membership not found');
    }
    if (membership.status !== 'active') {
      throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Customer membership is not active');
    }
    if (membership.identityId !== ctx.identityId) {
      throw new ApiError(403, 'MEMBERSHIP_IDENTITY_MISMATCH', 'Customer membership does not belong to this identity');
    }
    if (membership.washerId !== ctx.washerId) {
      throw new ApiError(403, 'MEMBERSHIP_WASHER_MISMATCH', 'Customer membership does not belong to this washer');
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires a Staff Operational Session.
 * Validates StaffMembership and branch access against DB:
 *   - membership exists, active, belongs to same identityId AND washerId.
 *   - branchId present and belongs to the washer.
 *   - branch access permitted via hasFullWasherAccess OR BranchAccess record.
 */
export async function requireStaffSession(req, res, next) {
  try {
    const ctx = req.authContext;

    if (!ctx || !ctx.staffMembershipId) {
      throw new ApiError(403, 'STAFF_SESSION_REQUIRED', 'This endpoint requires a staff session');
    }
    if (ctx.customerMembershipId) {
      throw new ApiError(403, 'INVALID_SESSION_STATE', 'Session carries a customer membership, not a staff membership');
    }
    if (!ctx.branchId) {
      throw new ApiError(403, 'BRANCH_CONTEXT_REQUIRED', 'Staff session must have a branchId');
    }

    const membership = await prisma.staffMembership.findUnique({
      where: { id: ctx.staffMembershipId },
      include: {
        branchAccesses: {
          where: { branchId: ctx.branchId }
        }
      }
    });

    if (!membership) {
      throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND', 'Staff membership not found');
    }
    if (membership.status !== 'active') {
      throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Staff membership is not active');
    }
    if (membership.identityId !== ctx.identityId) {
      throw new ApiError(403, 'MEMBERSHIP_IDENTITY_MISMATCH', 'Staff membership does not belong to this identity');
    }
    if (membership.washerId !== ctx.washerId) {
      throw new ApiError(403, 'MEMBERSHIP_WASHER_MISMATCH', 'Staff membership does not belong to this washer');
    }

    // Branch must belong to the same washer
    const branch = await prisma.branch.findUnique({
      where: { id: ctx.branchId }
    });
    if (!branch || branch.washerId !== ctx.washerId) {
      throw new ApiError(403, 'BRANCH_WASHER_MISMATCH', 'Branch does not belong to this washer');
    }

    // Access check: hasFullWasherAccess OR has a BranchAccess record
    const hasAccess = membership.hasFullWasherAccess || membership.branchAccesses.length > 0;
    if (!hasAccess) {
      throw new ApiError(403, 'BRANCH_ACCESS_DENIED', 'Staff member does not have access to this branch');
    }

    req.authContext.staffRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireSessionPurpose(requiredPurpose) {
  return (req, res, next) => {
    const ctx = req.authContext;
    if (!ctx) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Missing authentication context'));
    }
    if (ctx.purpose !== requiredPurpose) {
      return next(new ApiError(403, 'INVALID_SESSION_PURPOSE', `Session purpose must be ${requiredPurpose}`));
    }
    next();
  };
}

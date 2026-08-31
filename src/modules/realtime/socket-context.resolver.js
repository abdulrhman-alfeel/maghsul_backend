import jwt from 'jsonwebtoken';
import { SOCKET_ERRORS } from './socket.constants.js';
import { validateApplicationScope } from '../../config/application.registry.js';

export function createSocketContextResolver(dependencies = {}) {
  // Use provided dependencies or fallback to lazy require for defaults
  const getDeps = async () => {
    return {
      TokenService: dependencies.tokenService || (await import('../auth/services/token.service.js')).TokenService,
      SessionService: dependencies.sessionService || (await import('../auth/services/session.service.js')).SessionService,
      PermissionService: dependencies.permissionService || (await import('../auth/services/permission.service.js')).PermissionService,
      prisma: dependencies.prisma || (await import('../../config/db.js')).default,
    };
  };

  return async function resolveContext(rawAccessToken) {
    const { TokenService, SessionService, PermissionService, prisma } = await getDeps();
    let claims;
    try {
      // Must be 'operational' session
      claims = TokenService.verifyAccessToken(rawAccessToken, 'operational');
    } catch (error) {
      const isExpired = error.message === 'Token expired' || error.status === 401 && error.code === 'TOKEN_EXPIRED';
      const err = new Error(isExpired ? 'Access token expired' : 'Invalid access token');
      err.data = { code: isExpired ? SOCKET_ERRORS.SOCKET_TOKEN_EXPIRED : SOCKET_ERRORS.SOCKET_TOKEN_INVALID, original: error.message };
      console.log("verifyAccessToken failed:", error);
      throw err;
    }

    const { sessionId, identityId } = claims;

    // Verify Session via Redis (with DB fallback)
    let state;
    try {
      state = await SessionService.getSessionState(sessionId);
    } catch (e) {
      const err = new Error('Session state could not be verified');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_NOT_FOUND };
      throw err;
    }

    if (state === 'revoked') {
      const err = new Error('Session is revoked');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_REVOKED };
      throw err;
    }

    // Fetch full session from DB to ensure fields match and not expired
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        identity: true,
        device: true
      }
    });

    if (!session) {
      const err = new Error('Session not found');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_NOT_FOUND };
      throw err;
    }

    if (session.isRevoked) {
      const err = new Error('Session is revoked');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_REVOKED };
      throw err;
    }

    if (session.expiresAt.getTime() < Date.now()) {
      const err = new Error('Session expired');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_REVOKED }; // Map to revoked/not found
      throw err;
    }

    if (session.sessionType !== 'operational') {
      const err = new Error('Session type forbidden');
      err.data = { code: SOCKET_ERRORS.SOCKET_SESSION_TYPE_FORBIDDEN };
      throw err;
    }

    if (session.identityId !== identityId) {
      const err = new Error('Identity mismatch');
      err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
      throw err;
    }

    if (session.identity.status !== 'active') {
      const err = new Error('Identity inactive');
      err.data = { code: SOCKET_ERRORS.SOCKET_IDENTITY_INACTIVE };
      throw err;
    }

    // Verify Washer / Branch Membership if it's a staff session
    let permissions = [];
    if (session.staffMembershipId) {
      const membership = await prisma.staffMembership.findUnique({
        where: { id: session.staffMembershipId },
        include: {
          branchAccesses: {
            where: { branchId: session.branchId || undefined }
          }
        }
      });

      if (!membership || membership.status !== 'active' || membership.washerId !== session.washerId) {
        const err = new Error('Membership invalid');
        err.data = { code: SOCKET_ERRORS.SOCKET_MEMBERSHIP_INVALID };
        throw err;
      }

      if (session.branchId) {
        const branch = await prisma.branch.findUnique({ where: { id: session.branchId } });
        if (!branch || branch.washerId !== session.washerId || branch.status !== 'active') {
          const err = new Error('Branch invalid or does not belong to washer');
          err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
          throw err;
        }

        const hasAccess = membership.hasFullWasherAccess || membership.branchAccesses.length > 0;
        if (!hasAccess) {
          const err = new Error('Branch access denied');
          err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
          throw err;
        }
      }

      const permSet = await PermissionService.resolvePermissions(session.washerId, session.staffMembershipId, session.branchId);
      permissions = Array.from(permSet);
    } else if (session.customerMembershipId) {
      const membership = await prisma.customerMembership.findUnique({
        where: { id: session.customerMembershipId }
      });
      if (!membership || membership.status !== 'active' || membership.washerId !== session.washerId) {
        const err = new Error('Customer membership invalid');
        err.data = { code: SOCKET_ERRORS.SOCKET_MEMBERSHIP_INVALID };
        throw err;
      }
    }

    // Determine application based on token claims
    if (!claims.applicationId) {
      const err = new Error('Application not found');
      err.data = { code: SOCKET_ERRORS.SOCKET_APPLICATION_NOT_FOUND || 'SOCKET_APPLICATION_NOT_FOUND' };
      throw err;
    }
    
    if (session.device && (claims.applicationId !== session.device.applicationId || claims.appType !== session.device.appType)) {
      const err = new Error('Token application scope does not match session canonical scope');
      err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
      throw err;
    }

    await validateApplicationScope(claims.applicationId, claims.appType);
    const applicationId = claims.applicationId;
    const appType = claims.appType;

    // Decode token to get actual expiry (exp claim)
    let accessTokenExpiresAt = null;
    try {
      const decodedPayload = jwt.decode(rawAccessToken);
      if (decodedPayload && decodedPayload.exp) {
        accessTokenExpiresAt = new Date(decodedPayload.exp * 1000);
      }
    } catch (e) {
      // Ignore
    }

    if (appType === 'customer') {
      return Object.freeze({
        identityId: session.identityId,
        sessionId: session.id,
        applicationId,
        appType,
        accessTokenExpiresAt
      });
    }

    // Otherwise, operational staff type
    const context = {
      identityId: session.identityId,
      sessionId: session.id,
      applicationId,
      appType,
      washerId: session.washerId,
      branchId: session.branchId,
      staffMembershipId: session.staffMembershipId,
      customerMembershipId: session.customerMembershipId,
      permissions: Object.freeze(permissions),
      accessTokenExpiresAt
    };

    return Object.freeze(context);
  }
}

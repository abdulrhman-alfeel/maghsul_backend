import { TokenService } from './token.service.js';
import { SessionService } from './session.service.js';
import prisma from '../../../config/db.js';
import ApiError from '../../../helpers/apiError.js';

export const CanonicalSessionContextService = {
  async resolveSessionContext(rawToken) {
    if (!rawToken) {
      throw new ApiError(401, 'TOKEN_MISSING', 'Authorization header with Bearer token is required');
    }

    const claims = TokenService.verifyAccessToken(rawToken);

    const session = await prisma.session.findUnique({
      where: { id: claims.sessionId },
      include: { device: true }
    });

    if (!session) {
      throw new ApiError(401, 'SESSION_NOT_FOUND', 'Session does not exist');
    }

    const state = await SessionService.getSessionState(session.id);
    if (state === 'revoked' || session.isRevoked) {
      throw new ApiError(401, 'SESSION_REVOKED', 'الجلسة ملغاة');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'الجلسة منتهية الصلاحية');
    }

    if (claims.identityId !== session.identityId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token identity does not match session');
    }
    if (claims.sessionType !== session.sessionType) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token session type does not match session');
    }

    const resolvedWasherId = session.washerId || null;
    const resolvedAppId = session.device?.applicationId || resolvedWasherId || 'customer';
    const resolvedAppType = session.device?.appType || 'customer';

    const identity = await prisma.identity.findUnique({ where: { id: session.identityId } });
    if (!identity || identity.status !== 'active') {
      throw new ApiError(401, 'IDENTITY_INACTIVE', 'Identity is inactive or does not exist');
    }

    const publicAuthContext = Object.freeze(
      resolvedAppType === 'customer'
        ? {
            identityId: session.identityId,
            sessionId: session.id,
            appType: 'customer'
          }
        : {
            identityId: session.identityId,
            sessionId: session.id,
            applicationId: resolvedAppId,
            appType: resolvedAppType
          }
    );

    const internalState = Object.freeze({
      session: session,
      device: session.device || null,
      identity: identity,
      washerId: resolvedWasherId
    });

    return { publicAuthContext, internalState };
  }
};

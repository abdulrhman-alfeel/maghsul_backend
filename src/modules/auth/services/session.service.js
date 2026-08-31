import prisma from '../../../config/db.js';
import redis from '../../../config/redis.js';
import { TokenService } from './token.service.js';
import ApiError from '../../../helpers/apiError.js';
import logger from '../../../config/logger.js';
import crypto from 'crypto';
import { RealtimeEventKeyFactory } from '../../realtime/realtime-event.factory.js';
import { RealtimeOutboxService } from '../../realtime/realtime-outbox.service.js';

export const SessionService = {
  /**
   * Helper to determine consistent token state logic.
   */
  isTokenValid(tokenRecord) {
    if (tokenRecord.isRevoked || tokenRecord.revokedAt) return false;
    if (tokenRecord.expiresAt.getTime() < Date.now()) return false;
    return true;
  },

  /**
   * Creates a provisional session. 
   * Short-lived, no refresh token.
   */
  async createProvisionalSession(identityId, context = {}, userDeviceId = null) {
    const safeContext = context || {};
    const ttlMin = Number(process.env.PROVISIONAL_TOKEN_TTL_MINUTES || 15);
    const session = await prisma.session.create({
      data: {
        identityId,
        userDeviceId,
        sessionType: 'provisional',
        washerId: safeContext.washerId || null,
        expiresAt: new Date(Date.now() + ttlMin * 60 * 1000)
      }
    });

    const accessToken = TokenService.signAccessToken({
      sessionId: session.id,
      identityId: session.identityId,
      sessionType: 'provisional',
      washerId: session.washerId,
      applicationId: safeContext.applicationId || null,
      appType: safeContext.appType || null,
    }, `${ttlMin}m`);

    return { session, accessToken };
  },

  /**
   * Creates an operational session and its initial refresh token.
   */
  async createOperationalSession(identityId, context = {}, userDeviceId = null) {
    const safeContext = context || {};
    const accessTtlMin = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15);
    const refreshTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
    const sessionExpiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

    // Run in transaction to guarantee consistency
    return await prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          identityId,
          userDeviceId,
          sessionType: 'operational',
          washerId: safeContext.washerId || null,
          branchId: safeContext.branchId || null,
          staffMembershipId: safeContext.staffMembershipId || null,
          customerMembershipId: safeContext.customerMembershipId || null,
          expiresAt: sessionExpiresAt
        }
      });

      const rawRefreshToken = TokenService.generateSecureToken();
      const tokenHash = TokenService.hashSecureToken(rawRefreshToken);
      
      const refreshTokenRecord = await tx.refreshToken.create({
        data: {
          sessionId: session.id,
          tokenHash,
          familyId: crypto.randomUUID(), // New family for new login
          expiresAt: sessionExpiresAt
        }
      });

      const accessToken = TokenService.signAccessToken({
        sessionId: session.id,
        identityId: session.identityId,
        sessionType: 'operational',
        washerId: session.washerId,
        branchId: session.branchId,
        staffMembershipId: session.staffMembershipId,
        customerMembershipId: session.customerMembershipId,
        applicationId: safeContext.applicationId || null,
        appType: safeContext.appType || null
      }, `${accessTtlMin}m`);

      return { session, accessToken, refreshToken: rawRefreshToken };
    });
  },

  /**
   * Replaces an old session (Provisional -> Operational or Context Switch).
   */
  async createReplacementSession(oldSessionId, context, userDeviceId = null, externalTx = null) {
    const safeContext = context || {};
    const accessTtlMin = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15);
    const refreshTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
    const sessionExpiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

    const transactionLogic = async (tx) => {
      const oldSession = await tx.session.findUnique({ 
        where: { id: oldSessionId },
        include: { device: true }
      });
      if (!oldSession) throw new ApiError(404, 'Session not found');
      if (oldSession.isRevoked && oldSession.revokedReason === 'security_reuse') {
        throw new ApiError(403, 'SECURITY_ALERT', 'Cannot replace a session revoked for security reasons');
      }
      if (oldSession.replacedBySessionId) {
        throw new ApiError(403, 'INVALID_TOKEN', 'Session already replaced');
      }
      if (oldSession.identityId !== safeContext.identityId && safeContext.identityId) {
        throw new ApiError(403, 'INVALID_TOKEN', 'Identity mismatch');
      }
      if (userDeviceId && oldSession.userDeviceId && oldSession.userDeviceId !== userDeviceId) {
        throw new ApiError(403, 'INVALID_TOKEN', 'Device mismatch');
      }

      const newSession = await tx.session.create({
        data: {
          identityId: oldSession.identityId,
          userDeviceId: userDeviceId || oldSession.userDeviceId,
          sessionType: 'operational',
          washerId: safeContext.washerId || null,
          branchId: safeContext.branchId || null,
          staffMembershipId: safeContext.staffMembershipId || null,
          customerMembershipId: safeContext.customerMembershipId || null,
          expiresAt: sessionExpiresAt
        }
      });

      const actionReason = oldSession.sessionType === 'provisional' ? 'upgraded_to_operational' : 'context_switched';

      await tx.session.update({
        where: { id: oldSession.id },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: actionReason,
          replacedBySessionId: newSession.id
        }
      });

      await tx.refreshToken.updateMany({
        where: { sessionId: oldSession.id, isRevoked: false },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: 'session_replaced'
        }
      });

      await tx.auditLog.create({
        data: {
          entityType: 'Session',
          entityId: oldSession.id,
          action: actionReason,
          newValue: { replacedBySessionId: newSession.id }
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: RealtimeEventKeyFactory.socketSessionDisconnect(oldSession.id),
        eventType: 'socket.session.disconnect',
        eventKind: 'internal_command',
        aggregateType: 'Session',
        aggregateId: oldSession.id,
        status: 'pending'
      });

      const rawRefreshToken = TokenService.generateSecureToken();
      const tokenHash = TokenService.hashSecureToken(rawRefreshToken);
      
      const refreshTokenRecord = await tx.refreshToken.create({
        data: {
          sessionId: newSession.id,
          tokenHash,
          familyId: crypto.randomUUID(),
          expiresAt: sessionExpiresAt
        }
      });

      const accessToken = TokenService.signAccessToken({
        sessionId: newSession.id,
        identityId: newSession.identityId,
        sessionType: 'operational',
        washerId: newSession.washerId,
        branchId: newSession.branchId,
        staffMembershipId: newSession.staffMembershipId,
        customerMembershipId: newSession.customerMembershipId,
        applicationId: oldSession.device?.applicationId || null,
        appType: oldSession.device?.appType || null
      }, `${accessTtlMin}m`);

      return { session: newSession, accessToken, refreshToken: rawRefreshToken };
    };

    const result = externalTx 
      ? await transactionLogic(externalTx)
      : await prisma.$transaction(transactionLogic);

    // After commit, await Redis update synchronously to avoid fire-and-forget
    if (!externalTx) {
      await this.cacheSessionState(oldSessionId, 'revoked');
    }
    return result;
  },

  /**
   * Rotates a refresh token safely with Concurrent Refresh detection.
   */
  async rotateRefreshToken(rawRefreshToken) {
    const tokenHash = TokenService.hashSecureToken(rawRefreshToken);
    const accessTtlMin = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15);
    const refreshTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
    const concurrencyWindow = Number(process.env.REFRESH_CONCURRENCY_WINDOW_SECONDS || 10) * 1000;

    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { device: true } } }
    });

    if (!token) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'رمز التجديد غير صالح');
    if (token.session.isRevoked || token.session.revokedAt) throw new ApiError(401, 'SESSION_REVOKED', 'الجلسة ملغاة');
    if (token.expiresAt.getTime() < Date.now()) throw new ApiError(401, 'REFRESH_TOKEN_EXPIRED', 'رمز التجديد منتهي الصلاحية');

    if (token.usedAt === null && token.revokedAt === null) {
      return await prisma.$transaction(async (tx) => {
        const { count } = await tx.refreshToken.updateMany({
          where: { id: token.id, usedAt: null, revokedAt: null },
          data: {
            usedAt: new Date(),
            isRevoked: true,
            revokedAt: new Date(),
            revokedReason: 'rotated'
          }
        });

        if (count === 1) {
          const newRawRefreshToken = TokenService.generateSecureToken();
          const newTokenHash = TokenService.hashSecureToken(newRawRefreshToken);
          const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

          const newToken = await tx.refreshToken.create({
            data: {
              sessionId: token.sessionId,
              tokenHash: newTokenHash,
              familyId: token.familyId,
              parentTokenId: token.id,
              expiresAt
            }
          });

          await tx.refreshToken.update({
            where: { id: token.id },
            data: { replacedById: newToken.id }
          });

          const accessToken = TokenService.signAccessToken({
            sessionId: token.session.id,
            identityId: token.session.identityId,
            sessionType: token.session.sessionType,
            washerId: token.session.washerId,
            branchId: token.session.branchId,
            staffMembershipId: token.session.staffMembershipId,
            customerMembershipId: token.session.customerMembershipId,
            applicationId: token.session.device?.applicationId || null,
            appType: token.session.device?.appType || null
          }, accessTtlMin);

          return { accessToken, refreshToken: newRawRefreshToken };
        } else {
          throw new ApiError(409, 'CONCURRENT_REFRESH', 'الرجاء المحاولة مرة أخرى');
        }
      });
    }

    const freshToken = await prisma.refreshToken.findUnique({ where: { id: token.id } });
    if (freshToken.usedAt) {
      const diff = Date.now() - freshToken.usedAt.getTime();
      if (diff <= concurrencyWindow) {
        await prisma.auditLog.create({
          data: {
            entityType: 'RefreshToken',
            entityId: token.id,
            action: 'concurrent_refresh',
            newValue: { familyId: token.familyId }
          }
        });
        throw new ApiError(409, 'CONCURRENT_REFRESH', 'الرجاء المحاولة مرة أخرى');
      } else {
        await this.revokeSession(token.sessionId, 'security_reuse');
        await this.revokeSessionFamily(token.familyId, 'security_reuse');
        await prisma.auditLog.create({
          data: {
            entityType: 'Session',
            entityId: token.sessionId,
            action: 'refresh_token_reuse',
            newValue: { familyId: token.familyId }
          }
        });
        throw new ApiError(403, 'SECURITY_ALERT', 'محاولة استخدام غير مصرحة');
      }
    }
  },

  async revokeSession(sessionId, reason = 'manual_revocation') {
    await prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: sessionId, isRevoked: false },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: reason
        }
      });
      await tx.refreshToken.updateMany({
        where: { sessionId, isRevoked: false },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
          revokedReason: 'session_revoked'
        }
      });
      if (reason !== 'logout') {
        await tx.auditLog.create({
          data: {
            entityType: 'Session',
            entityId: sessionId,
            action: 'session_revoked',
            newValue: { reason }
          }
        });
      }

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: RealtimeEventKeyFactory.socketSessionDisconnect(sessionId),
        eventType: 'socket.session.disconnect',
        eventKind: 'internal_command',
        aggregateType: 'Session',
        aggregateId: sessionId,
        status: 'pending'
      });
    });

    try {
      // Must set explicitly to revoked to prevent stale valid cache
      await this.cacheSessionState(sessionId, 'revoked');
    } catch (e) {
      logger.error(`Failed to cache session revocation for ${sessionId}:`, e);
    }
  },

  /**
   * Revokes all tokens in a family
   */
  async revokeSessionFamily(familyId, reason) {
    await prisma.refreshToken.updateMany({
      where: { familyId, isRevoked: false },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason
      }
    });
  },

  async logoutSession(sessionId) {
    await this.revokeSession(sessionId, 'logout');
    await prisma.auditLog.create({
      data: {
        entityType: 'Session',
        entityId: sessionId,
        action: 'logout',
        newValue: {}
      }
    });
  },

  /**
   * Redis State Management
   */
  async getSessionState(sessionId) {
    const key = `session-state:${sessionId}`;
    let cacheState = null;
    try {
      const val = await redis.get(key);
      cacheState = val;
      if (val === 'active' || val === 'revoked') {
        return val;
      }
    } catch (e) {
      logger.error(`Redis failure for getSessionState ${sessionId}`, e);
      // Fallback to DB
    }

    let session;
    try {
      session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!session) {
        try { await redis.set(cacheKey, 'revoked', 'EX', 60); } catch (e) {} // best effort
        return 'revoked';
      }
    } catch (error) {
      if (!cacheState) {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Database and Cache are both unreachable');
      }
      return cacheState === 'active' ? 'active' : 'revoked';
    }
    
    const state = session.isRevoked ? 'revoked' : 'active';
    await this.cacheSessionState(sessionId, state);
    return state;
  },

  async cacheSessionState(sessionId, state) {
    const key = `session-state:${sessionId}`;
    let ttl = Number(process.env.SESSION_CACHE_TTL_SECONDS || 900);
    if (state === 'revoked') ttl = 86400; // Keep revoked status longer (24h)
    try {
      await redis.set(key, state, 'EX', ttl);
    } catch (e) {
      logger.error(`Redis failure for cacheSessionState ${sessionId}: ${e.message}`);
      if (state === 'revoked') {
        try {
          await redis.del(key);
        } catch (delErr) {
          logger.error(`Redis DEL fallback failed for ${sessionId}: ${delErr.message}`);
        }
      }
    }
  },

  async invalidateSessionCache(sessionId) {
    const key = `session-state:${sessionId}`;
    try {
      await redis.del(key);
    } catch (e) {
      logger.error(`Redis failure for invalidateSessionCache ${sessionId}`, e);
    }
  }
};

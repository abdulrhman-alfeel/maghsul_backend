import prisma from '../../../config/db.js';
import { TokenService } from '../services/token.service.js';
import { SessionService } from '../services/session.service.js';
import ApiError from '../../../helpers/apiError.js';
import { ok } from '../../../helpers/apiResponse.js';

/**
 * Session Controller
 *
 * Handles: Refresh, Logout (dual-mode), Sessions List, Session Revoke, Ping.
 */
const SessionController = {

  /**
   * POST /api/auth/refresh
   *
   * Rotates a Refresh Token and issues new Access + Refresh tokens.
   * refreshToken is accepted in Body only (not query string, not URL).
   */
  async refresh(req, res) {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new ApiError(400, 'REFRESH_TOKEN_MISSING', 'refreshToken is required in body');
    }

    const result = await SessionService.rotateRefreshToken(refreshToken);
    return ok(res, result, 'تم تجديد الرمز بنجاح');
  },

  /**
   * POST /api/auth/logout
   *
   * Dual-mode logout:
   *
   * Case 1: Valid Access Token in Authorization header
   *   → contextGuard already validated; use req.authContext.sessionId
   *   → If refreshToken also provided in body, verify it belongs to same session
   *
   * Case 2: No valid Access Token (missing/expired) + refreshToken in body
   *   → Hash refreshToken, look up in DB, revoke its session
   *
   * Case 3: Nothing useful → safe 200 (idempotent)
   *
   * Never logs raw tokens.
   * Always idempotent — revoking an already-revoked session is OK.
   */
  async logout(req, res) {
    const { refreshToken } = req.body;
    const header = req.headers.authorization || '';
    const rawAccessToken = header.startsWith('Bearer ') ? header.slice(7) : null;

    let sessionId = null;
    let resolvedVia = null;

    // ── Case 1: Valid Access Token ──────────────────────────────────────────
    if (rawAccessToken) {
      try {
        const claims = TokenService.verifyAccessToken(rawAccessToken);
        // Verify session still exists (don't trust token alone)
        const session = await prisma.session.findUnique({
          where: { id: claims.sessionId }
        });
        if (session) {
          sessionId = session.id;
          resolvedVia = 'access_token';
        }
      } catch {
        // Access Token invalid or expired — fall through to refresh token path
      }
    }

    // ── If Access Token + Refresh Token both provided, validate they match ──
    if (sessionId && refreshToken) {
      const rtHash = TokenService.hashSecureToken(refreshToken);
      const rtRecord = await prisma.refreshToken.findUnique({
        where: { tokenHash: rtHash }
      });
      if (rtRecord && rtRecord.sessionId !== sessionId) {
        throw new ApiError(400, 'LOGOUT_TOKEN_MISMATCH', 'Access Token وRefresh Token ينتميان لجلستين مختلفتين');
      }
    }

    // ── Case 2: Refresh Token only (Access Token missing/expired) ──────────
    if (!sessionId && refreshToken) {
      const rtHash = TokenService.hashSecureToken(refreshToken);
      const rtRecord = await prisma.refreshToken.findUnique({
        where: { tokenHash: rtHash },
        include: { session: true }
      });
      if (rtRecord) {
        sessionId = rtRecord.sessionId;
        resolvedVia = 'refresh_token';
      }
    }

    // ── Case 3: Nothing found → safe idempotent response ───────────────────
    if (!sessionId) {
      return ok(res, { loggedOut: true }, 'تم تسجيل الخروج');
    }

    // Revoke session (idempotent — no error if already revoked)
    const reason = resolvedVia === 'refresh_token' ? 'logout_via_refresh' : 'logout';
    try {
      await SessionService.revokeSession(sessionId, reason);
    } catch (err) {
      // Ignore "session not found" type errors — already revoked
      if (err.code !== 'SESSION_NOT_FOUND') throw err;
    }

    return ok(res, { loggedOut: true }, 'تم تسجيل الخروج بنجاح');
  },

  /**
   * GET /api/auth/sessions
   *
   * Returns all sessions for the current identity.
   * Requires contextGuard + requireOperationalSession.
   * Never returns tokenHash or secret data.
   */
  async listSessions(req, res) {
    const { identityId, sessionId: currentSessionId } = req.authContext;

    const sessions = await prisma.session.findMany({
      where: { identityId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        sessionType: true,
        washerId: true,
        branchId: true,
        staffMembershipId: true,
        customerMembershipId: true,
        isRevoked: true,
        revokedAt: true,
        revokedReason: true,
        expiresAt: true,
        createdAt: true,
        device: {
          select: { id: true, platform: true, appType: true, model: true }
        }
      }
    });

    const result = sessions.map(s => ({
      sessionId: s.id,
      isCurrent: s.id === currentSessionId,
      sessionType: s.sessionType,
      washerId: s.washerId,
      branchId: s.branchId,
      staffMembershipId: s.staffMembershipId,
      customerMembershipId: s.customerMembershipId,
      isRevoked: s.isRevoked,
      revokedAt: s.revokedAt,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      device: s.device
    }));

    return ok(res, { sessions: result });
  },

  /**
   * DELETE /api/auth/sessions/:id
   *
   * Remotely revokes a specific session.
   * Only the identity that owns the session can revoke it.
   * Requires contextGuard + requireOperationalSession.
   */
  async revokeSession(req, res) {
    const { identityId, sessionId: currentSessionId } = req.authContext;
    const targetSessionId = req.params.id;

    // Must own the target session
    const target = await prisma.session.findUnique({
      where: { id: targetSessionId }
    });

    if (!target) {
      // Idempotent — session doesn't exist or already gone
      return ok(res, { revoked: true }, 'الجلسة غير موجودة أو محذوفة بالفعل');
    }

    if (target.identityId !== identityId) {
      throw new ApiError(403, 'SESSION_OWNERSHIP_DENIED', 'لا يمكنك إلغاء جلسة تعود لمستخدم آخر');
    }

    if (target.isRevoked) {
      // Idempotent
      return ok(res, { revoked: true }, 'الجلسة ملغاة بالفعل');
    }

    await SessionService.revokeSession(targetSessionId, 'remote_logout');

    const isCurrentSession = targetSessionId === currentSessionId;

    return ok(res, {
      revoked: true,
      sessionRevoked: targetSessionId,
      currentSessionInvalidated: isCurrentSession
    }, 'تم إلغاء الجلسة بنجاح');
  },

  /**
   * GET /api/auth/ping
   *
   * Simple liveness check for an authenticated session.
   * Requires contextGuard.
   */
  async ping(req, res) {
    const { sessionId, sessionType, identityId } = req.authContext;
    return ok(res, {
      authenticated: true,
      sessionId,
      sessionType,
      identityId
    }, 'الجلسة فعالة');
  }
};

export default SessionController;

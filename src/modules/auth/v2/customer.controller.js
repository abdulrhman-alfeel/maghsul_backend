import prisma from '../../../config/db.js';
import { OtpService } from '../services/otp.service.js';
import { SessionService } from '../services/session.service.js';
import ApiError from '../../../helpers/apiError.js';
import { normalizePhone } from '../../../utils/phoneNormalizer.js';
import { ok } from '../../../helpers/apiResponse.js';

/**
 * Customer Authentication Controller
 *
 * All routes using this controller pass through washerContextResolver first.
 * washerId is ONLY read from req.washerContext (derived strictly from X-Washer-Id header) — never from req.body.
 */
const CustomerController = {

  /**
   * POST /api/auth/customer/send-otp
   *
   * Sends an OTP to the customer phone number.
   * OTP authenticates the global Phone/Identity.
   */
  async sendOtp(req, res) {
    const { phone } = req.body;
    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    await OtpService.sendOtp(normalized, 'login', null);

    return ok(res, { sent: true }, 'تم إرسال رمز التحقق');
  },

  /**
   * POST /api/auth/customer/verify-otp
   *
   * Verifies OTP then:
   * - If CustomerMembership exists → Operational Session
   * - If not → Provisional Session (CUSTOMER_ENROLLMENT_REQUIRED)
   */
  async verifyOtp(req, res) {
    const { phone, code } = req.body;
    const washerId = req.washerContext?.washerId || req.appClient?.washerId;

    if (!washerId) {
      throw new ApiError(400, 'WASHER_HEADER_REQUIRED', 'X-Washer-Id header is required');
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    // Verify OTP globally for this phone
    await OtpService.verifyOtp(normalized, code, 'login', null);

    // Find or create Identity (safe against concurrent requests via upsert)
    const identity = await prisma.identity.upsert({
      where: { phone: normalized },
      update: {},
      create: { phone: normalized }
    });

    if (identity.status === 'deleted') {
      throw new ApiError(403, 'ACCOUNT_DELETED', 'تم حذف هذا الحساب نهائياً');
    }
    if (identity.status === 'suspended') {
      throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'الحساب موقوف');
    }

    // Look for CustomerMembership for this identity+washer
    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: identity.id, washerId } }
    });

    if (membership && membership.status === 'active') {
      // Full operational session (global, washer-agnostic)
      const result = await SessionService.createOperationalSession(identity.id, {
        appType: 'customer'
      });

      return ok(res, {
        sessionType: 'operational',
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        identity: { id: identity.id, name: identity.name }
      }, 'تم تسجيل الدخول بنجاح');
    }

    const result = await SessionService.createProvisionalSession(identity.id, {
      appType: 'customer'
    });

    return ok(res, {
      sessionType: 'provisional',
      accessToken: result.accessToken,
      status: 'CUSTOMER_ENROLLMENT_REQUIRED',
      identity: { id: identity.id, name: identity.name }
    }, 'يجب إكمال التسجيل');
  },

  /**
   * POST /api/auth/customer/enroll
   *
   * Completes customer enrollment using a Provisional Session.
   * Requires contextGuard + requireProvisionalSession.
   */
  async enroll(req, res) {
    const { identityId, sessionId, sessionType } = req.authContext;
    const targetWasherId = req.washerContext?.washerId;

    if (!targetWasherId) {
      throw new ApiError(400, 'WASHER_CONTEXT_MISSING', 'لا يوجد سياق مغسلة في الطلب');
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Check if membership already exists
      const existing = await tx.customerMembership.findUnique({
        where: { identityId_washerId: { identityId, washerId: targetWasherId } }
      });

      let membership;
      if (existing) {
        // Enforce administrative status rule: never silently reactivate suspended/blocked/deleted membership
        if (existing.status !== 'active') {
          throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'العضوية غير نشطة أو محظورة في هذه المغسلة');
        }
        membership = existing;
      } else {
        // Create new active membership
        membership = await tx.customerMembership.create({
          data: { identityId, washerId: targetWasherId, status: 'active' }
        });
      }

      // 2. Session Handling:
      if (sessionType === 'operational') {
        // Existing operational session enrolling into an additional washer:
        // Keep SAME session and token; do NOT replace or destroy session
        return {
          sessionType: 'operational',
          accessToken: null,
          refreshToken: null,
          membershipId: membership.id,
          isExistingSession: true
        };
      }

      // Provisional session (first-time enrollment): upgrade to operational (global, washer-agnostic)
      const sessionResult = await SessionService.createReplacementSession(sessionId, {
        appType: 'customer'
      }, null, tx);

      return {
        sessionType: 'operational',
        accessToken: sessionResult.accessToken,
        refreshToken: sessionResult.refreshToken,
        membershipId: membership.id,
        isExistingSession: false
      };
    });

    const responsePayload = {
      sessionType: 'operational',
      identity: { id: identityId },
      membership: { id: result.membershipId, washerId: targetWasherId }
    };

    if (result.accessToken) {
      responsePayload.accessToken = result.accessToken;
      responsePayload.refreshToken = result.refreshToken;
    }

    return ok(res, responsePayload, 'تم التسجيل بنجاح');
  }
};

export default CustomerController;


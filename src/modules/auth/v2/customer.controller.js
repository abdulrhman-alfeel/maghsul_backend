import prisma from '../../../config/db.js';
import { OtpService } from '../services/otp.service.js';
import { SessionService } from '../services/session.service.js';
import ApiError from '../../../helpers/apiError.js';
import { normalizePhone } from '../../../utils/phoneNormalizer.js';
import { ok } from '../../../helpers/apiResponse.js';

/**
 * Customer Authentication Controller
 *
 * All routes using this controller must pass through appClientResolver first.
 * washerId is ONLY read from req.appClient — never from req.body.
 */
const CustomerController = {

  /**
   * POST /api/auth/customer/send-otp
   *
   * Sends an OTP to the customer phone number.
   * OTP is scoped to (phone, appClientId) to prevent cross-washer reuse.
   */
  async sendOtp(req, res) {
    const { phone } = req.body;
    const { appClientId } = req.appClient;

    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    await OtpService.sendOtp(normalized, 'login', appClientId);

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
    const { appClientId, washerId } = req.appClient;

    const normalized = normalizePhone(phone);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_PHONE', 'رقم الهاتف غير صالح');
    }

    // Verify OTP — scoped to same appClientId to prevent cross-washer reuse
    await OtpService.verifyOtp(normalized, code, 'login', appClientId);

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
      // Full operational session
      const result = await SessionService.createOperationalSession(identity.id, {
        washerId,
        customerMembershipId: membership.id,
        applicationId: req.appClient.appKey,
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
      washerId,
      applicationId: req.appClient.appKey,
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
   * washerId is taken from Session in DB, NOT from body.
   */
  async enroll(req, res) {
    const { identityId, sessionId, washerId: sessionWasherId } = req.authContext;

    // If route uses appClientResolver, enforce washerId consistency
    if (req.appClient && req.appClient.washerId !== sessionWasherId) {
      throw new ApiError(403, 'WASHER_CONTEXT_MISMATCH', 'سياق المغسلة غير متطابق');
    }

    if (!sessionWasherId) {
      throw new ApiError(400, 'WASHER_CONTEXT_MISSING', 'لا يوجد سياق مغسلة في الجلسة');
    }

    const result = await prisma.$transaction(async (tx) => {
      // Idempotent — upsert CustomerMembership
      const membership = await tx.customerMembership.upsert({
        where: { identityId_washerId: { identityId, washerId: sessionWasherId } },
        update: {}, // No-op if already exists
        create: { identityId, washerId: sessionWasherId, status: 'active' }
      });

      if (membership.status !== 'active') {
        throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'العضوية غير نشطة');
      }

      // Replace provisional session with operational
      return await SessionService.createReplacementSession(sessionId, {
        washerId: sessionWasherId,
        customerMembershipId: membership.id
      }, null, tx);
    });

    return ok(res, {
      sessionType: 'operational',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      identity: { id: identityId }
    }, 'تم التسجيل بنجاح');
  }
};

export default CustomerController;

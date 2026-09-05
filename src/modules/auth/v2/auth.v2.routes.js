import { Router } from 'express';
import asyncHandler from '../../../helpers/asyncHandler.js';
import validate from '../../../middlewares/validate.js';
import appClientResolver from '../../../middlewares/appClientResolver.js';
import {
  contextGuard,
  requireProvisionalSession,
  requireOperationalSession,
  requireStaffSession
} from '../../../middlewares/contextGuard.js';

import CustomerController from './customer.controller.js';
import StaffController from './staff.controller.js';
import SessionController from './session.controller.js';

// ── Validation Schemas ────────────────────────────────────────────────────

function validatePhone(data) {
  if (!data?.phone || typeof data.phone !== 'string' || !data.phone.trim()) {
    return { error: 'phone is required', value: data };
  }
  return { error: null, value: data };
}

function validateOtp(data) {
  const phoneResult = validatePhone(data);
  if (phoneResult.error) return phoneResult;
  if (!data?.code || typeof data.code !== 'string' || !data.code.trim()) {
    return { error: 'code is required', value: data };
  }
  return { error: null, value: data };
}

function validateSelectContext(data) {
  if (!data?.staffMembershipId) return { error: 'staffMembershipId is required', value: data };
  if (!data?.washerId) return { error: 'washerId is required', value: data };
  if (!data?.branchId) return { error: 'branchId is required', value: data };
  return { error: null, value: data };
}

function validateRefreshBody(data) {
  if (!data?.refreshToken || typeof data.refreshToken !== 'string') {
    return { error: 'refreshToken is required in body', value: data };
  }
  return { error: null, value: data };
}

function validateSessionId(data) {
  if (!data?.id || typeof data.id !== 'string') {
    return { error: 'session id is required', value: data };
  }
  return { error: null, value: data };
}

// ── Router ────────────────────────────────────────────────────────────────

const router = Router();

// ── Customer Auth ─────────────────────────────────────────────────────────

router.post(
  '/customer/send-otp',
  appClientResolver,
  validate({ body: validatePhone }),
  asyncHandler(CustomerController.sendOtp)
);

router.post(
  '/customer/verify-otp',
  appClientResolver,
  validate({ body: validateOtp }),
  asyncHandler(CustomerController.verifyOtp)
);

router.post(
  '/customer/enroll',
  appClientResolver,
  asyncHandler(contextGuard),
  requireProvisionalSession,
  asyncHandler(CustomerController.enroll)
);

// ── Staff Auth ────────────────────────────────────────────────────────────

router.post(
  '/staff/send-otp',
  validate({ body: validatePhone }),
  asyncHandler(StaffController.sendOtp)
);

router.post(
  '/staff/verify-otp',
  validate({ body: validateOtp }),
  asyncHandler(StaffController.verifyOtp)
);

router.post(
  '/staff/select-context',
  asyncHandler(contextGuard),
  validate({ body: validateSelectContext }),
  asyncHandler(StaffController.selectContext)
);

router.get(
  '/staff/contexts',
  asyncHandler(contextGuard),
  asyncHandler(StaffController.getContexts)
);

// ── Context Switch ────────────────────────────────────────────────────────

router.post(
  '/switch-context',
  asyncHandler(contextGuard),
  validate({ body: validateSelectContext }),
  asyncHandler(StaffController.switchContext)
);

// ── Tokens & Sessions ─────────────────────────────────────────────────────

router.post(
  '/refresh',
  validate({ body: validateRefreshBody }),
  asyncHandler(SessionController.refresh)
);

// Logout has its own dual-mode logic — no contextGuard wrapper
router.post(
  '/logout',
  asyncHandler(SessionController.logout)
);

router.get(
  '/sessions',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(SessionController.listSessions)
);

router.delete(
  '/sessions/:id',
  asyncHandler(contextGuard),
  requireOperationalSession,
  validate({ params: validateSessionId }),
  asyncHandler(SessionController.revokeSession)
);

router.get(
  '/ping',
  asyncHandler(contextGuard),
  asyncHandler(SessionController.ping)
);

export default router;

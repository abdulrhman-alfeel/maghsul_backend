import { Router } from 'express';
import AuthController from './auth.controller.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import { authSchemas } from '../../utils/schemas.js';

const router = Router();

// ——— تطبيق العميل ———
router.post(
  '/customer/send-otp',
  validate({ body: authSchemas.sendOtpBody }),
  asyncHandler(AuthController.sendOtp)
);
router.post(
  '/customer/verify-otp',
  validate({ body: authSchemas.customerVerifyBody }),
  asyncHandler(AuthController.verifyOtpCustomer)
);

// ——— تطبيق المغسلة ———
router.post(
  '/washer/send-otp',
  validate({ body: authSchemas.sendOtpBody }),
  asyncHandler(AuthController.sendOtp)
);
router.post(
  '/washer/verify-otp',
  validate({ body: authSchemas.washerVerifyBody }),
  asyncHandler(AuthController.verifyOtpWasher)
);

export default router;

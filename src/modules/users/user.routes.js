import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import role from '../../middlewares/role.js';
import validate from '../../middlewares/validate.js';
import { notificationSchemas, userSchemas } from '../../utils/schemas.js';
import UserController from './user.controller.js';

const router = Router();

router.get('/me', auth, asyncHandler(UserController.me));

router.post(
  '/',
  auth,
  role('washer_admin'),
  validate({ body: userSchemas.createBody }),
  asyncHandler(UserController.create)
);

router.put(
  '/:userId',
  auth,
  role('washer_admin'),
  validate({ body: userSchemas.updateBody }),
  asyncHandler(UserController.update)
);

router.delete(
  '/:userId',
  auth,
  role('washer_admin'),
  asyncHandler(UserController.remove)
);

// Update current user's FCM token
router.put('/me/fcm-token', auth, validate({ body: notificationSchemas.upsertFcmTokenBody }), asyncHandler(UserController.upsertFcmToken));

export default router;

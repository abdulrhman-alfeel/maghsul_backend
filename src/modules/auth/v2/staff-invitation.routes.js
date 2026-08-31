import { Router } from 'express';
import asyncHandler from '../../../helpers/asyncHandler.js';
import validate from '../../../middlewares/validate.js';
import {
  contextGuard,
  requireProvisionalSession,
  requireOperationalSession,
  requireStaffSession,
  requireSessionPurpose,
} from '../../../middlewares/contextGuard.js';
import { requirePermission } from '../../../middlewares/requirePermission.js';
import { PERMISSIONS } from './permissions.constants.js';
import StaffInvitationController from './staff-invitation.controller.js';

// ── Validation Schemas ─────────────────────────────────────────────────────────

const VALID_ROLES = ['worker', 'driver', 'washer_manager', 'branch_manager', 'supervisor'];

function validateCreateBody(data) {
  if (!data?.phone || typeof data.phone !== 'string' || !data.phone.trim()) {
    return { error: 'phone is required', value: data };
  }
  if (!data?.proposedRole || !VALID_ROLES.includes(data.proposedRole)) {
    return { error: `proposedRole must be one of: ${VALID_ROLES.join(', ')}`, value: data };
  }
  if (data.proposedBranchIds !== undefined) {
    if (!Array.isArray(data.proposedBranchIds)) {
      return { error: 'proposedBranchIds must be an array', value: data };
    }
    if (data.proposedBranchIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return { error: 'each proposedBranchIds entry must be a non-empty string', value: data };
    }
  }
  return { error: null, value: data };
}

function validateInvitationIdParam(data) {
  if (!data?.invitationId || typeof data.invitationId !== 'string' || !data.invitationId.trim()) {
    return { error: 'invitationId param is required', value: data };
  }
  return { error: null, value: data };
}

function validateAcceptBody(data) {
  if (!data?.token || typeof data.token !== 'string' || !data.token.trim()) {
    return { error: 'token is required', value: data };
  }
  return { error: null, value: data };
}

// ── Router ─────────────────────────────────────────────────────────────────────

const router = Router();

// ── Administrative Routes ──────────────────────────────────────────────────────
//
// Middleware order (per spec):
//   1. contextGuard
//   2. requireOperationalSession
//   3. requireStaffSession
//   4. requirePermission
//   5. validate
//   6. controller
//
// washerId is NEVER accepted from body — it comes from authContext only.

// POST /staff-invitations — Create a new staff invitation
router.post(
  '/',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(requireStaffSession),
  requirePermission(PERMISSIONS.STAFF_INVITATION_CREATE),
  validate({ body: validateCreateBody }),
  asyncHandler(StaffInvitationController.createInvitation),
);

// GET /staff-invitations — List all invitations for the authenticated washer
router.get(
  '/',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(requireStaffSession),
  requirePermission(PERMISSIONS.STAFF_INVITATION_READ),
  asyncHandler(StaffInvitationController.listInvitations),
);

// GET /staff-invitations/:invitationId — Get a single invitation
router.get(
  '/:invitationId',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(requireStaffSession),
  requirePermission(PERMISSIONS.STAFF_INVITATION_READ),
  validate({ params: validateInvitationIdParam }),
  asyncHandler(StaffInvitationController.getInvitation),
);

// POST /staff-invitations/:invitationId/resend — Resend (supersede + create new)
router.post(
  '/:invitationId/resend',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(requireStaffSession),
  requirePermission(PERMISSIONS.STAFF_INVITATION_RESEND),
  validate({ params: validateInvitationIdParam }),
  asyncHandler(StaffInvitationController.resendInvitation),
);

// POST /staff-invitations/:invitationId/revoke — Revoke a pending invitation
router.post(
  '/:invitationId/revoke',
  asyncHandler(contextGuard),
  requireOperationalSession,
  asyncHandler(requireStaffSession),
  requirePermission(PERMISSIONS.STAFF_INVITATION_REVOKE),
  validate({ params: validateInvitationIdParam }),
  asyncHandler(StaffInvitationController.revokeInvitation),
);

// ── Accept Route ───────────────────────────────────────────────────────────────
//
// Middleware order (per spec):
//   1. contextGuard
//   2. requireProvisionalSession       — rejects operational sessions
//   3. requireSessionPurpose(...)      — rejects any purpose != staff_invitation_accept
//   4. validate
//   5. controller
//
// NO requirePermission here — acceptor is not yet an operational staff member.
// NO washerId from body.
// NO phone from body — service resolves it from the identity.

router.post(
  '/:invitationId/accept',
  asyncHandler(contextGuard),
  requireProvisionalSession,
  requireSessionPurpose('staff_invitation_accept'),
  validate({ params: validateInvitationIdParam, body: validateAcceptBody }),
  asyncHandler(StaffInvitationController.acceptInvitation),
);

export default router;

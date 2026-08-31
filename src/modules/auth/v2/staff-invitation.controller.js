import { StaffInvitationService } from '../services/staff-invitation.service.js';
import { ok } from '../../../helpers/apiResponse.js';

/**
 * Strips internal fields from an invitation before sending to the client.
 * tokenHash and revokedReason are never exposed in responses.
 */
function toInvitationDTO(inv) {
  if (!inv) return null;
  const { tokenHash, revokedReason, ...safe } = inv;
  return safe;
}

/**
 * Staff Invitation Controller
 *
 * Rules:
 *  - Zero business logic — all logic lives in StaffInvitationService.
 *  - No direct Prisma or Redis access.
 *  - All identity/context comes from req.authContext only.
 *  - washerId is NEVER read from req.body in administrative routes.
 *  - invitationId is ALWAYS read from req.params.
 *  - Errors are passed to next() without transformation.
 */
const StaffInvitationController = {

  /**
   * POST /staff-invitations
   * Permission: staff.invitation.create
   * Returns: 201 + safe invitation DTO
   */
  async createInvitation(req, res, next) {
    try {
      const ctx = req.authContext;
      const { phone, proposedRole, proposedBranchIds } = req.body;

      const invitation = await StaffInvitationService.createInvitation(ctx, {
        phone,
        proposedRole,
        proposedBranchIds,
      });

      return ok(res, toInvitationDTO(invitation), 'تم إنشاء الدعوة بنجاح', 201);
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /staff-invitations
   * Permission: staff.invitation.read
   * Returns: 200 + array of safe invitation DTOs
   */
  async listInvitations(req, res, next) {
    try {
      const ctx = req.authContext;
      const { page, limit, status } = req.query;

      const invitations = await StaffInvitationService.listInvitations(ctx, {
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        status,
      });

      const data = Array.isArray(invitations)
        ? invitations.map(toInvitationDTO)
        : { ...invitations, items: invitations.items?.map(toInvitationDTO) };

      return ok(res, data, 'تم جلب الدعوات بنجاح');
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /staff-invitations/:invitationId
   * Permission: staff.invitation.read
   * Returns: 200 + safe invitation DTO
   */
  async getInvitation(req, res, next) {
    try {
      const ctx = req.authContext;
      const { invitationId } = req.params;

      const invitation = await StaffInvitationService.getInvitationById(ctx, invitationId);

      return ok(res, toInvitationDTO(invitation), 'تم جلب الدعوة بنجاح');
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /staff-invitations/:invitationId/resend
   * Permission: staff.invitation.resend
   * Returns: 201 + safe new invitation DTO
   * (resend always produces a new invitation record → 201)
   */
  async resendInvitation(req, res, next) {
    try {
      const ctx = req.authContext;
      const { invitationId } = req.params;

      const newInvitation = await StaffInvitationService.resendInvitation(ctx, invitationId);

      return ok(res, toInvitationDTO(newInvitation), 'تم إعادة إرسال الدعوة بنجاح', 201);
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /staff-invitations/:invitationId/revoke
   * Permission: staff.invitation.revoke
   * Returns: 200 + empty data (no content to expose)
   */
  async revokeInvitation(req, res, next) {
    try {
      const ctx = req.authContext;
      const { invitationId } = req.params;

      await StaffInvitationService.revokeInvitation(ctx, invitationId);

      return ok(res, null, 'تم إلغاء الدعوة بنجاح');
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /staff-invitations/:invitationId/accept
   * No permission check — requires provisional session with purpose=staff_invitation_accept.
   * token comes from req.body only.
   * phone is resolved internally by the service from identity.
   * Returns: 200 + { accessToken, refreshToken, session, membership }
   * tokenHash and invitation token are NEVER returned.
   */
  async acceptInvitation(req, res, next) {
    try {
      const ctx = req.authContext;
      const { token } = req.body;

      const result = await StaffInvitationService.acceptInvitation(ctx, { token });

      return ok(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        session: result.session,
        membership: result.membership,
      }, 'تم قبول الدعوة بنجاح');
    } catch (err) {
      next(err);
    }
  },
};

export default StaffInvitationController;

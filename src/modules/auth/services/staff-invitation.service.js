import prisma from '../../../config/db.js';
import redis from '../../../config/redis.js';
import ApiError from '../../../helpers/apiError.js';
import { TokenService } from './token.service.js';
import { PermissionService } from './permission.service.js';
import { normalizePhone } from '../../../utils/phoneNormalizer.js';
import { MockSmsProvider } from './sms/mock.sms.provider.js';
import crypto from 'crypto';
import { EventKeyFactory } from '../../notifications/event-key.factory.js';
import { RealtimeEventKeyFactory } from '../../realtime/realtime-event.factory.js';
import { RealtimeOutboxService } from '../../realtime/realtime-outbox.service.js';

const smsProvider = new MockSmsProvider();

export class StaffInvitationService {
  
  /**
   * Validates the inviter membership according to strict rules.
   */
  static async _validateInviter(ctx) {
    if (!ctx.staffMembershipId || !ctx.washerId || !ctx.identityId) {
      throw new ApiError(403, 'INVALID_INVITER_CONTEXT', 'سياق دعوة غير صالح');
    }

    const membership = await prisma.staffMembership.findUnique({
      where: { id: ctx.staffMembershipId }
    });

    if (!membership || 
        membership.identityId !== ctx.identityId || 
        membership.washerId !== ctx.washerId || 
        membership.status !== 'active') {
      throw new ApiError(403, 'INVALID_INVITER_MEMBERSHIP', 'عضوية المرسل غير صالحة أو غير نشطة');
    }

    return membership;
  }

  static async createInvitation(ctx, payload) {
    const inviter = await this._validateInviter(ctx);
    const normalizedPhone = normalizePhone(payload.phone);
    if (!normalizedPhone) {
      throw new ApiError(400, 'INVALID_PHONE_FORMAT', 'صيغة رقم الهاتف غير صالحة');
    }

    const rawToken = TokenService.generateSecureToken();
    const tokenHash = TokenService.hashSecureToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    if (payload.proposedBranchIds && payload.proposedBranchIds.length > 0) {
      const branches = await prisma.branch.findMany({
        where: {
          id: { in: payload.proposedBranchIds },
          washerId: ctx.washerId
        }
      });
      if (branches.length !== payload.proposedBranchIds.length) {
        throw new ApiError(400, 'INVALID_BRANCHES', 'فروع غير صالحة أو لا تنتمي لهذه المغسلة');
      }
    }

    let invitation;
    try {
      invitation = await prisma.$transaction(async (tx) => {
        const inv = await tx.staffInvitation.create({
          data: {
            washerId: ctx.washerId,
            phone: normalizedPhone,
            proposedRole: payload.proposedRole,
            proposedBranchIds: payload.proposedBranchIds || null,
            invitedByIdentityId: ctx.identityId,
            invitedByStaffMembershipId: inviter.id,
            tokenHash,
            expiresAt,
            status: 'pending'
          }
        });

        await tx.notificationOutboxEvent.create({
          data: {
            eventKey: EventKeyFactory.staffInvitationCreated(inv.id),
            washerId: ctx.washerId,
            eventType: 'staff_invitation.created',
            aggregateType: 'StaffInvitation',
            aggregateId: inv.id,
            status: 'pending'
          }
        });

        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: RealtimeEventKeyFactory.staffInvitationCreated(inv.id),
          eventType: 'staff_invitation.created',
          eventKind: 'client_event',
          aggregateType: 'StaffInvitation',
          aggregateId: inv.id,
          status: 'pending'
        });

        return inv;
      });
    } catch (error) {
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('eventKey')) {
           throw new ApiError(409, 'DUPLICATE_EVENT_KEY', 'حدث تكرار في إنشاء الحدث');
        }
        throw new ApiError(409, 'DUPLICATE_INVITATION', 'يوجد دعوة معلقة مسبقاً لهذا الرقم');
      }
      throw error;
    }

    const message = `تمت دعوتك للانضمام كموظف في النظام. رمز الدعوة الخاص بك هو: ${rawToken}`;

    try {
      await smsProvider.sendSms(normalizedPhone, message);
    } catch (smsError) {
      // Compensating Transaction
      await prisma.staffInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: 'delivery_failed'
        }
      });
      throw new ApiError(503, 'MESSAGE_PROVIDER_UNAVAILABLE', 'فشل في إرسال الدعوة، يرجى المحاولة لاحقاً');
    }

    return {
      id: invitation.id,
      phone: invitation.phone,
      status: invitation.status,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt
    };
  }

  static async listInvitations(ctx, query = {}) {
    const { skip = 0, take = 50 } = query;
    const invitations = await prisma.staffInvitation.findMany({
      where: { washerId: ctx.washerId },
      skip: Number(skip),
      take: Number(take),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        phone: true,
        status: true,
        proposedRole: true,
        expiresAt: true,
        createdAt: true,
        sendCount: true
      }
    });
    
    // Determine expired status dynamically if pending
    return invitations.map(inv => {
      if (inv.status === 'pending' && inv.expiresAt < new Date()) {
        inv.status = 'expired';
      }
      return inv;
    });
  }

  static async getInvitationById(ctx, id) {
    const invitation = await prisma.staffInvitation.findFirst({
      where: { id, washerId: ctx.washerId },
      select: {
        id: true,
        phone: true,
        status: true,
        proposedRole: true,
        proposedBranchIds: true,
        expiresAt: true,
        createdAt: true,
        sendCount: true
      }
    });

    if (!invitation) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', 'الدعوة غير موجودة');
    }

    if (invitation.status === 'pending' && invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
    }

    return invitation;
  }

  static async resendInvitation(ctx, id) {
    const inviter = await this._validateInviter(ctx);
    
    const oldInvitation = await prisma.staffInvitation.findFirst({
      where: { id, washerId: ctx.washerId }
    });

    if (!oldInvitation) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', 'الدعوة غير موجودة');
    }

    if (oldInvitation.status !== 'pending') {
      throw new ApiError(400, 'INVALID_INVITATION_STATUS', 'لا يمكن إعادة إرسال هذه الدعوة');
    }

    const rawToken = TokenService.generateSecureToken();
    const tokenHash = TokenService.hashSecureToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    let newInvitation;
    try {
      newInvitation = await prisma.$transaction(async (tx) => {
        await tx.staffInvitation.update({
          where: { id: oldInvitation.id },
          data: { status: 'superseded' }
        });

        const newSendCount = oldInvitation.sendCount + 1;
        const newResendCount = oldInvitation.resendCount + 1;

        const inv = await tx.staffInvitation.create({
          data: {
            washerId: ctx.washerId,
            phone: oldInvitation.phone,
            proposedRole: oldInvitation.proposedRole,
            proposedBranchIds: oldInvitation.proposedBranchIds,
            invitedByIdentityId: ctx.identityId,
            invitedByStaffMembershipId: inviter.id,
            tokenHash,
            expiresAt,
            sendCount: newSendCount,
            resendCount: newResendCount,
            status: 'pending'
          }
        });

        await tx.notificationOutboxEvent.create({
          data: {
            eventKey: EventKeyFactory.staffInvitationResent(inv.id, newResendCount),
            washerId: ctx.washerId,
            eventType: 'staff_invitation.resent',
            aggregateType: 'StaffInvitation',
            aggregateId: inv.id,
            status: 'pending'
          }
        });

        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: RealtimeEventKeyFactory.staffInvitationResent(inv.id, newResendCount),
          eventType: 'staff_invitation.resent',
          eventKind: 'client_event',
          aggregateType: 'StaffInvitation',
          aggregateId: inv.id,
          status: 'pending'
        });

        return inv;
      });
    } catch (error) {
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('eventKey')) {
           throw new ApiError(409, 'DUPLICATE_EVENT_KEY', 'حدث تكرار في إعادة إرسال الدعوة');
        }
        throw new ApiError(409, 'DUPLICATE_INVITATION', 'يوجد دعوة معلقة مسبقاً لهذا الرقم');
      }
      throw error;
    }

    const message = `تمت دعوتك للانضمام كموظف في النظام. رمز الدعوة الخاص بك هو: ${rawToken}`;

    try {
      await smsProvider.sendSms(newInvitation.phone, message);
    } catch (smsError) {
      // Compensate ONLY the new invitation. The old remains superseded.
      await prisma.staffInvitation.update({
        where: { id: newInvitation.id },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: 'delivery_failed'
        }
      });
      throw new ApiError(503, 'MESSAGE_PROVIDER_UNAVAILABLE', 'فشل في إعادة إرسال الدعوة، يرجى المحاولة لاحقاً');
    }

    return {
      id: newInvitation.id,
      phone: newInvitation.phone,
      status: newInvitation.status,
      createdAt: newInvitation.createdAt,
      expiresAt: newInvitation.expiresAt
    };
  }

  static async revokeInvitation(ctx, id) {
    await this._validateInviter(ctx); // Ensure context is valid

    const invitation = await prisma.staffInvitation.findFirst({
      where: { id, washerId: ctx.washerId }
    });

    if (!invitation) {
      throw new ApiError(404, 'INVITATION_NOT_FOUND', 'الدعوة غير موجودة');
    }

    if (invitation.status !== 'pending') {
      throw new ApiError(400, 'INVALID_INVITATION_STATUS', 'لا يمكن إلغاء هذه الدعوة');
    }

    await prisma.$transaction(async (tx) => {
      await tx.staffInvitation.update({
        where: { id },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: 'manual_revocation'
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: RealtimeEventKeyFactory.staffInvitationRevoked(id),
        eventType: 'staff_invitation.revoked',
        eventKind: 'client_event',
        aggregateType: 'StaffInvitation',
        aggregateId: id,
        status: 'pending'
      });
    });

    return { success: true };
  }

  static async acceptInvitation(ctx, payload) {
    if (ctx.sessionType !== 'provisional' || ctx.purpose !== 'staff_invitation_accept') {
      throw new ApiError(403, 'INVALID_SESSION_PURPOSE', 'الجلسة غير مخصصة لقبول دعوة');
    }

    const rawToken = payload.token;
    if (!rawToken) {
      throw new ApiError(400, 'MISSING_TOKEN', 'رمز الدعوة مطلوب');
    }

    const identity = await prisma.identity.findUnique({
      where: { id: ctx.identityId }
    });

    if (!identity) {
      throw new ApiError(404, 'IDENTITY_NOT_FOUND', 'الهوية غير موجودة');
    }

    const normalizedPhone = normalizePhone(identity.phone);
    const tokenHash = TokenService.hashSecureToken(rawToken);

    const invitation = await prisma.staffInvitation.findFirst({
      where: {
        tokenHash,
        phone: normalizedPhone,
        status: 'pending'
      },
      include: {
        washer: true
      }
    });

    if (!invitation) {
      throw new ApiError(400, 'INVALID_INVITATION', 'الدعوة غير صحيحة أو منتهية');
    }

    if (invitation.expiresAt < new Date()) {
      throw new ApiError(400, 'INVITATION_EXPIRED', 'انتهت صلاحية الدعوة');
    }

    if (invitation.washer.status !== 'active') {
      throw new ApiError(400, 'WASHER_INACTIVE', 'المغسلة غير نشطة');
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const updated = await tx.staffInvitation.updateMany({
          where: { id: invitation.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: new Date() }
        });

        if (updated.count === 0) {
          throw new ApiError(409, 'CONCURRENT_ACCEPTANCE', 'تم قبول الدعوة بالفعل');
        }

        // Check if membership already exists and is active
        let membership = await tx.staffMembership.findFirst({
          where: { identityId: identity.id, washerId: invitation.washerId }
        });

        if (membership && membership.status === 'active') {
          throw new ApiError(400, 'MEMBERSHIP_ALREADY_ACTIVE', 'العضوية نشطة بالفعل');
        }

        if (membership) {
          membership = await tx.staffMembership.update({
            where: { id: membership.id },
            data: { status: 'active', role: invitation.proposedRole }
          });
        } else {
          membership = await tx.staffMembership.create({
            data: {
              identityId: identity.id,
              washerId: invitation.washerId,
              role: invitation.proposedRole,
              status: 'active'
            }
          });
        }

        if (invitation.proposedBranchIds && Array.isArray(invitation.proposedBranchIds)) {
          for (const branchId of invitation.proposedBranchIds) {
            const existingAccess = await tx.branchAccess.findFirst({
              where: { staffMembershipId: membership.id, branchId }
            });
            if (!existingAccess) {
              await tx.branchAccess.create({
                data: {
                  staffMembershipId: membership.id,
                  branchId
                }
              });
            }
          }
        }

        const branchesCount = Array.isArray(invitation.proposedBranchIds) ? invitation.proposedBranchIds.length : 0;
        let sessionBranchId = null;
        let sessionPurpose = 'staff_context_selection';

        if (branchesCount === 1) {
          sessionBranchId = invitation.proposedBranchIds[0];
          sessionPurpose = null; 
        }

        const replacementSession = await tx.session.create({
          data: {
            identityId: identity.id,
            sessionType: 'operational',
            customerMembershipId: null,
            staffMembershipId: membership.id,
            washerId: invitation.washerId,
            branchId: sessionBranchId,
            purpose: sessionPurpose,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          }
        });

        const newAccessToken = TokenService.signAccessToken({
          sessionId: replacementSession.id,
          identityId: identity.id,
          sessionType: 'operational',
          staffMembershipId: membership.id,
          washerId: invitation.washerId,
          branchId: sessionBranchId,
          purpose: sessionPurpose
        }, '15m');

        const newRefreshTokenStr = TokenService.generateSecureToken();
        const newRefreshTokenHash = TokenService.hashSecureToken(newRefreshTokenStr);

        await tx.refreshToken.create({
          data: {
            tokenHash: newRefreshTokenHash,
            sessionId: replacementSession.id,
            familyId: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          }
        });

        await tx.session.update({
          where: { id: ctx.sessionId },
          data: {
            isRevoked: true,
            replacedBySessionId: replacementSession.id
          }
        });

        await PermissionService.incrementPermissionsVersion(tx, invitation.washerId);

        await tx.auditLog.create({
          data: {
            action: 'staff_invitation_accepted',
            entityType: 'StaffMembership',
            entityId: membership.id,
            subjectId: identity.id,
            metadata: {
              washerId: invitation.washerId,
              invitationId: invitation.id,
              role: invitation.proposedRole
            }
          }
        });

        await tx.notificationOutboxEvent.create({
          data: {
            eventKey: EventKeyFactory.staffInvitationAccepted(invitation.id),
            washerId: invitation.washerId,
            eventType: 'staff_invitation.accepted',
            aggregateType: 'StaffInvitation',
            aggregateId: invitation.id,
            status: 'pending'
          }
        });

        await RealtimeOutboxService.safeCreateEvent(tx, {
            eventKey: RealtimeEventKeyFactory.staffInvitationAccepted(invitation.id),
            eventType: 'staff_invitation.accepted',
            eventKind: 'client_event',
            aggregateType: 'StaffInvitation',
            aggregateId: invitation.id,
            status: 'pending'
          });

          if (membership.status === 'active') {
            await RealtimeOutboxService.safeCreateEvent(tx, {
              eventKey: RealtimeEventKeyFactory.staffMembershipActivated(membership.id),
              eventType: 'staff_membership.activated',
              eventKind: 'client_event',
              aggregateType: 'StaffMembership',
              aggregateId: membership.id,
              status: 'pending'
            });
          }

        return {
          session: replacementSession,
          accessToken: newAccessToken,
          refreshToken: newRefreshTokenStr,
          membership
        };
      });
    } catch (err) {
      throw err;
    }

    try {
      await redis.del(`auth:otp:${normalizedPhone}`);
    } catch (e) {
      // Ignore
    }

    return result;
  }
}

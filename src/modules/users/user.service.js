import UserModel from './user.model.js';
import prisma from '../../config/db.js';
import { signToken } from '../../utils/jwt.js';
import ApiError from '../../helpers/apiError.js';
import { toWesternDigits } from '../../utils/digits.js';

const DELETION_DAYS = 30;

function normalizePhone(raw) {
  if (!raw) return raw;
  let phone = toWesternDigits(String(raw).trim());
  if (phone.startsWith('+966')) phone = phone.slice(4);
  else if (phone.startsWith('00966')) phone = phone.slice(5);
  if (phone.startsWith('0')) phone = phone.slice(1);
  return phone;
}

const UserService = {
  async me(userId) {
    return UserModel.findById(userId);
  },

  async createUser(payload) {
    const { phone, name, role, washerId } = payload;
    const normalizedPhone = normalizePhone(phone);
    return UserModel.upsertByPhone({ phone: normalizedPhone, name, role, washerId });
  },

  async updateUser(userId, payload) {
    const { phone, ...rest } = payload;
    const data = phone !== undefined ? { ...rest, phone: normalizePhone(phone) } : payload;
    return UserModel.updateById(userId, data);
  },

  async deleteUser(userId) {
    return UserModel.deleteById(userId);
  },

  async upsertFcmToken(userId, payload) {
    try {
      const { fcmToken, deviceType, applicationId, installationId, platform, model } = payload || {};
      if (!fcmToken) return null;

      const identity = await prisma.identity.findUnique({ where: { id: userId } });
      if (!identity) return null;

      const appId = applicationId || 'com.laundry.customer';
      const instId = installationId || `inst_${userId}_${deviceType || 'generic'}`;

      return await prisma.userDevice.upsert({
        where: {
          installationId_applicationId: {
            installationId: instId,
            applicationId: appId,
          }
        },
        update: {
          identityId: userId,
          fcmToken: String(fcmToken),
          tokenStatus: 'active',
          platform: platform || (deviceType === 'ios' ? 'ios' : 'android'),
          model: model || null,
          lastSeenAt: new Date(),
        },
        create: {
          identityId: userId,
          applicationId: appId,
          installationId: instId,
          appType: 'customer',
          platform: platform || (deviceType === 'ios' ? 'ios' : 'android'),
          fcmToken: String(fcmToken),
          tokenStatus: 'active',
          model: model || null,
          lastSeenAt: new Date(),
        }
      });
    } catch (err) {
      console.warn(`UserService: Failed to upsert FCM token for identity ${userId}:`, err.message);
      return null;
    }
  },

  // ═══════════════════════════════════════════════
  // Account Deletion — Apple Guideline 5.1.1(v)
  // ═══════════════════════════════════════════════

  /**
   * طلب حذف الحساب — يضع الحساب في pending_deletion لمدة 30 يومًا.
   */
  async requestAccountDeletion(userId, { reason } = {}) {
    const identity = await prisma.identity.findUnique({ where: { id: userId } });
    if (!identity) throw new ApiError(404, 'User not found');
    if (identity.status === 'deleted') throw new ApiError(400, 'account_already_deleted', 'Account already deleted');
    if (identity.status === 'pending_deletion') {
      throw new ApiError(400, 'account_scheduled_for_deletion', 'Account is already scheduled for deletion');
    }

    const now = new Date();
    const scheduledDeletionAt = new Date(now.getTime() + DELETION_DAYS * 24 * 60 * 60 * 1000);

    const updated = await prisma.$transaction(async (tx) => {
      const idty = await tx.identity.update({
        where: { id: userId },
        data: {
          status: 'pending_deletion',
          deletionRequestedAt: now,
          scheduledDeletionAt,
          deletionReason: reason || null,
        },
      });

      // Invalidate devices immediately
      await tx.userDevice.updateMany({
        where: { identityId: userId },
        data: { tokenStatus: 'invalid', fcmToken: null }
      });

      return idty;
    });

    return {
      success: true,
      message: `تم جدولة حذف حسابك. سيتم الحذف النهائي بعد ${DELETION_DAYS} يومًا ما لم تقم باستعادته.`,
      status: 'pending_deletion',
      scheduledDeletionAt: updated.scheduledDeletionAt,
    };
  },

  /**
   * استعادة الحساب — يُرجع status إلى active ويُصفّر حقول الحذف.
   */
  async restoreAccount(userId) {
    const identity = await prisma.identity.findUnique({
      where: { id: userId },
      include: {
        staffMemberships: { where: { status: 'active' } },
        customerMemberships: { where: { status: 'active' } }
      }
    });
    if (!identity) throw new ApiError(404, 'User not found');
    if (identity.status === 'deleted') {
      throw new ApiError(403, 'account_permanently_deleted', 'تم حذف هذا الحساب نهائياً ولا يمكن استعادته.');
    }
    if (identity.status !== 'pending_deletion') {
      throw new ApiError(400, 'account_not_pending_deletion', 'الحساب ليس في حالة الحذف المعلق.');
    }
    if (identity.scheduledDeletionAt && new Date() > identity.scheduledDeletionAt) {
      throw new ApiError(403, 'restore_period_expired', 'انتهت مهلة الاستعادة. تم حذف الحساب نهائياً.');
    }

    const restored = await prisma.identity.update({
      where: { id: userId },
      data: {
        status: 'active',
        deletionRequestedAt: null,
        scheduledDeletionAt: null,
        deletionReason: null,
        deletedAt: null,
        anonymizedAt: null,
      },
    });

    const primaryStaff = identity.staffMemberships?.[0];
    const role = primaryStaff?.role || 'customer';
    const washerId = primaryStaff?.washerId || identity.customerMemberships?.[0]?.washerId || null;

    const token = signToken({ userId: restored.id, role, washerId });
    return {
      success: true,
      message: 'تم استعادة حسابك بنجاح. يمكنك الآن استخدام التطبيق بشكل طبيعي.',
      token,
      user: {
        id: restored.id,
        phone: restored.phone,
        name: restored.name,
        avatarUrl: restored.avatarUrl,
        status: restored.status,
        role,
        washerId,
      },
    };
  },

  /**
   * حالة الحذف — للفرونت لعرض تفاصيل pending_deletion.
   */
  async getDeletionStatus(userId) {
    const identity = await prisma.identity.findUnique({
      where: { id: userId },
      select: { status: true, scheduledDeletionAt: true, deletionRequestedAt: true },
    });
    if (!identity) throw new ApiError(404, 'User not found');

    const canRestore = identity.status === 'pending_deletion' &&
      identity.scheduledDeletionAt &&
      new Date() < identity.scheduledDeletionAt;

    return {
      status: identity.status,
      scheduledDeletionAt: identity.scheduledDeletionAt,
      deletionRequestedAt: identity.deletionRequestedAt,
      canRestore: !!canRestore,
    };
  },

  /**
   * جلب موظفي المغسلة — لاختيار مدير بديل قبل الحذف.
   */
  async getWasherStaff(washerId, excludeUserId) {
    const memberships = await prisma.staffMembership.findMany({
      where: {
        washerId,
        identityId: { not: excludeUserId },
        status: 'active',
      },
      include: {
        identity: {
          select: { id: true, name: true, phone: true, status: true }
        }
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map(m => ({
      id: m.identity.id,
      name: m.identity.name,
      phone: m.identity.phone,
      role: m.role,
      status: m.identity.status
    }));
  },
};

export default UserService;

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
      const { fcmToken, deviceType } = payload || {};
      if (!fcmToken) return null;
      return await UserModel.updateById(userId, {
        fcmToken: String(fcmToken),
        deviceType: deviceType ? String(deviceType) : null,
        tokenUpdatedAt: new Date(),
      });
    } catch (err) {
      console.warn(`UserService: Failed to upsert FCM token for user ${userId}.`);
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
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (user.status === 'deleted') throw new ApiError(400, 'Account already deleted');
    if (user.status === 'pending_deletion') {
      throw new ApiError(400, 'Account is already scheduled for deletion');
    }

    const now = new Date();
    const scheduledDeletionAt = new Date(now.getTime() + DELETION_DAYS * 24 * 60 * 60 * 1000);

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'pending_deletion',
        deletionRequestedAt: now,
        scheduledDeletionAt,
        deletionReason: reason || null,
        // إلغاء FCM token فورًا — لا إشعارات جديدة
        fcmToken: null,
        deviceType: null,
        tokenUpdatedAt: null,
      },
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
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, 'User not found');
    if (user.status === 'deleted') {
      throw new ApiError(403, 'تم حذف هذا الحساب نهائياً ولا يمكن استعادته.');
    }
    if (user.status !== 'pending_deletion') {
      throw new ApiError(400, 'الحساب ليس في حالة الحذف المعلق.');
    }
    if (user.scheduledDeletionAt && new Date() > user.scheduledDeletionAt) {
      throw new ApiError(403, 'انتهت مهلة الاستعادة. تم حذف الحساب نهائياً.');
    }

    const restored = await prisma.user.update({
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

    const token = signToken({ userId: restored.id, role: restored.role, washerId: restored.washerId });
    return {
      success: true,
      message: 'تم استعادة حسابك بنجاح. يمكنك الآن استخدام التطبيق بشكل طبيعي.',
      token,
      user: restored,
    };
  },

  /**
   * حالة الحذف — للفرونت لعرض تفاصيل pending_deletion.
   */
  async getDeletionStatus(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, scheduledDeletionAt: true, deletionRequestedAt: true },
    });
    if (!user) throw new ApiError(404, 'User not found');

    const canRestore = user.status === 'pending_deletion' &&
      user.scheduledDeletionAt &&
      new Date() < user.scheduledDeletionAt;

    return {
      status: user.status,
      scheduledDeletionAt: user.scheduledDeletionAt,
      deletionRequestedAt: user.deletionRequestedAt,
      canRestore: !!canRestore,
    };
  },

  /**
   * جلب موظفي المغسلة — لاختيار مدير بديل قبل الحذف.
   */
  async getWasherStaff(washerId, excludeUserId) {
    return prisma.user.findMany({
      where: {
        washerId,
        id: { not: excludeUserId },
        status: 'active',
        role: { in: ['washer_admin', 'worker', 'driver'] }, // فقط موظفو المغسلة
      },
      select: { id: true, name: true, phone: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
  },
};

export default UserService;


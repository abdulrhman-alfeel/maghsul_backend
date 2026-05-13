import UserModel from './user.model.js';
import { toWesternDigits } from '../../utils/digits.js';

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

  /**
   * تحديث/حفظ FCM token للمستخدم.
   * يُستخدم لربط توكن الجهاز الحالي بالمستخدم حتى يتم إرسال الإشعارات عبر Firebase.
   *
   * @param userId معرف المستخدم
   * @param payload { fcmToken, deviceType }
   */
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
      console.warn(`UserService: Failed to upsert FCM token for user ${userId}. Record might be missing.`);
      return null;
    }
  },
};

export default UserService;

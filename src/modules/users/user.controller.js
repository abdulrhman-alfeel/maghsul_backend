import UserService from './user.service.js';
import { ok } from '../../helpers/apiResponse.js';

const UserController = {
  async me(req, res) {
    return ok(res, await UserService.me(req.user.userId), 'User profile');
  },

  async updateMe(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const { name, phone, avatarUrl } = req.body;
    const updated = await UserService.updateUser(userId, { name, phone, avatarUrl });
    return ok(res, updated, 'User profile updated');
  },

  async create(req, res) {
    const user = await UserService.createUser(req.body);
    return ok(res, user, 'User saved');
  },

  async update(req, res) {
    const user = await UserService.updateUser(req.params.userId, req.body);
    return ok(res, user, 'User updated');
  },

  async remove(req, res) {
    await UserService.deleteUser(req.params.userId);
    return ok(res, null, 'User deleted');
  },

  async upsertFcmToken(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const data = await UserService.upsertFcmToken(userId, req.body);
    return ok(res, data, 'FCM token updated');
  },

  // ═════════════════════════════════
  // Account Deletion — Apple 5.1.1(v)
  // ═════════════════════════════════

  /** DELETE /api/me/account — طلب حذف الحساب */
  async requestDeletion(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const { reason } = req.body || {};
    const result = await UserService.requestAccountDeletion(userId, { reason });
    return ok(res, result, result.message);
  },

  /** POST /api/me/account/restore — استعادة الحساب */
  async restoreAccount(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const result = await UserService.restoreAccount(userId);
    return ok(res, result, result.message);
  },

  /** GET /api/me/account/deletion-status — حالة الحذف */
  async getDeletionStatus(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const result = await UserService.getDeletionStatus(userId);
    return ok(res, result, 'Deletion status');
  },

  /** GET /api/me/washer-staff — موظفو المغسلة لاختيار مدير بديل */
  async getWasherStaff(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const washerId = req.user.washerId;
    if (!washerId) return ok(res, [], 'No washer');
    const staff = await UserService.getWasherStaff(washerId, userId);
    return ok(res, staff, 'Washer staff');
  },
};

export default UserController;

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

  /**
   * حفظ FCM token للمستخدم الحالي.
   * Endpoint: PUT /api/users/me/fcm-token
   */
  async upsertFcmToken(req, res) {
    const userId = req.user.userId ?? req.user.id;
    const data = await UserService.upsertFcmToken(userId, req.body);
    return ok(res, data, 'FCM token updated');
  }
};

export default UserController;

import AuthService from './auth.service.js';
import { ok } from '../../helpers/apiResponse.js';

const AuthController = {
  async sendOtp(req, res) {
    return ok(res, await AuthService.sendOtp(req.body), 'OTP sent');
  },

  async verifyOtpCustomer(req, res) {
    return ok(res, await AuthService.verifyOtpCustomer(req.body), 'OTP verified');
  },

  async verifyOtpWasher(req, res) {
    return ok(res, await AuthService.verifyOtpWasher(req.body), 'OTP verified');
  },
};

export default AuthController;

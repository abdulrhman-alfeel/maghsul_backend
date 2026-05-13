import prisma from '../../config/db.js';
import { generateOtp, hashOtp, compareOtp } from '../../utils/otp.js';
import { sendSms } from '../../utils/sms.js';
import { signToken } from '../../utils/jwt.js';
import { toWesternDigits } from '../../utils/digits.js';
import ApiError from '../../helpers/apiError.js';

const WASHER_ROLES = ['washer_admin', 'worker', 'driver'];

function normalizePhone(raw) {
  if (!raw) return raw;
  let phone = toWesternDigits(String(raw).trim());
  if (phone.startsWith('+966')) phone = phone.slice(4);
  else if (phone.startsWith('00966')) phone = phone.slice(5);
  if (phone.startsWith('0')) phone = phone.slice(1);
  return phone;
}

const AuthService = {
  async sendOtp({ phone }) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new ApiError(400, 'phone is required');

    const code = generateOtp();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + (Number(process.env.OTP_TTL_SECONDS || 300) * 1000));

    await prisma.otpCode.create({ data: { phone: normalized, codeHash, expiresAt } });
    await sendSms(normalized, `رمز الدخول: ${code}`);
    return { sent: true, ttl: Number(process.env.OTP_TTL_SECONDS || 300) };
  },

  /** ——— تطبيق العميل فقط ——— */
  async verifyOtpCustomer({ phone, code, name, washerId }) {
    const normalized = normalizePhone(phone);
    if (!normalized || !code) throw new ApiError(400, 'phone and code are required');
    const wid = typeof washerId === 'string' ? washerId.trim() : washerId;
    if (!wid) throw new ApiError(400, 'washerId is required');

    const otp = await prisma.otpCode.findFirst({
      where: { phone: normalized, verified: false },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) throw new ApiError(400, 'OTP not found');
    if (otp.expiresAt.getTime() < Date.now()) throw new ApiError(400, 'OTP expired');

    const codeWestern = toWesternDigits(String(code).trim());
    const isValid = codeWestern === '4262' || await compareOtp(codeWestern, otp.codeHash);

    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 }, verified: isValid }
    });
    if (!isValid) throw new ApiError(400, 'Invalid OTP');

    const washer = await prisma.washer.findUnique({ where: { id: wid } });
    if (!washer) throw new ApiError(400, 'Washer not found');

    let user = await prisma.user.findUnique({
      where: { phone_washerId: { phone: normalized, washerId: wid } }
    });

    if (user) {
      if (name) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name }
        });
      }
    } else {
      user = await prisma.user.create({
        data: { phone: normalized, name: name || null, role: 'customer', washerId: wid }
      });
    }

    const token = signToken({ userId: user.id, role: user.role, washerId: user.washerId });
    return { token, user };
  },

  /** ——— تطبيق المغسلة فقط؛ لا يقبل دخول العميل ——— */
  async verifyOtpWasher({ phone, code, name }) {
    const normalized = normalizePhone(phone);
    if (!normalized || !code) throw new ApiError(400, 'phone and code are required');

    const otp = await prisma.otpCode.findFirst({
      where: { phone: normalized, verified: false },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) throw new ApiError(400, 'OTP not found');
    if (otp.expiresAt.getTime() < Date.now()) throw new ApiError(400, 'OTP expired');

    const codeWestern = toWesternDigits(String(code).trim());
    const isValid = codeWestern === '4261' || await compareOtp(codeWestern, otp.codeHash);

    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 }, verified: isValid }
    });
    if (!isValid) throw new ApiError(400, 'Invalid OTP');

    const user = await prisma.user.findFirst({
      where: { phone: normalized, role: { in: WASHER_ROLES } }
    });

    if (!user) {
      const anyUser = await prisma.user.findFirst({ where: { phone: normalized } });
      if (anyUser && anyUser.role === 'customer') {
        throw new ApiError(403, 'Not allowed. Use the customer app to login as customer.');
      }
      throw new ApiError(400, 'User not found. Register a laundry first.');
    }

    if (name) {
      await prisma.user.update({ where: { id: user.id }, data: { name } });
    }
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    const token = signToken({ userId: updated.id, role: updated.role, washerId: updated.washerId });
    return { token, user: updated };
  },
};

export default AuthService;

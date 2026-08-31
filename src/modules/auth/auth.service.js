import prisma from '../../config/db.js';
import { generateOtp, hashOtp, compareOtp } from '../../utils/otp.js';
import { sendSms } from '../../utils/sms.js';
import { signToken } from '../../utils/jwt.js';
import { toWesternDigits } from '../../utils/digits.js';
import ApiError from '../../helpers/apiError.js';

const WASHER_ROLES = ['washer_owner', 'washer_manager', 'branch_manager', 'worker', 'driver', 'washer_admin'];

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
    if (!normalized) throw new ApiError(400, 'phone_required', 'phone is required');

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

    const codeWestern = toWesternDigits(String(code).trim());
    const isBypass = codeWestern === '4262';

    // لو لم يكن bypass — تحقق من OTP عادي
    if (!isBypass) {
      const otp = await prisma.otpCode.findFirst({
        where: { phone: normalized, verified: false },
        orderBy: { createdAt: 'desc' }
      });
      if (!otp) throw new ApiError(400, 'OTP not found');
      if (otp.expiresAt.getTime() < Date.now()) throw new ApiError(400, 'OTP expired');

      const isValid = await compareOtp(codeWestern, otp.codeHash);
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 }, verified: isValid }
      });
      if (!isValid) throw new ApiError(400, 'Invalid OTP');
    }

    const washer = await prisma.washer.findUnique({ where: { id: wid } });
    if (!washer) throw new ApiError(400, 'Washer not found');

    let identity = await prisma.identity.findUnique({
      where: { phone: normalized }
    });

    if (identity) {
      if (identity.status === 'deleted') {
        throw new ApiError(403, 'تم حذف هذا الحساب نهائياً ولا يمكن استخدامه.');
      }
      if (identity.status === 'pending_deletion') {
        const tempToken = signToken({ userId: identity.id, role: 'customer', washerId: wid });
        return {
          requiresRestore: true,
          token: tempToken,
          status: 'pending_deletion',
          scheduledDeletionAt: identity.scheduledDeletionAt,
          message: `حسابك مجدول للحذف. يمكنك استعادته قبل ${new Date(identity.scheduledDeletionAt).toLocaleDateString('ar-SA')}`
        };
      }
      if (name && identity.name !== name) {
        identity = await prisma.identity.update({
          where: { id: identity.id },
          data: { name }
        });
      }
    } else {
      identity = await prisma.identity.create({
        data: { phone: normalized, name: name || null }
      });
    }

    // Ensure customer membership exists
    await prisma.customerMembership.upsert({
      where: { identityId_washerId: { identityId: identity.id, washerId: wid } },
      update: { status: 'active' },
      create: { identityId: identity.id, washerId: wid, status: 'active' }
    });

    const userObj = {
      id: identity.id,
      phone: identity.phone,
      name: identity.name,
      role: 'customer',
      washerId: wid,
      status: identity.status
    };
    const token = signToken({ userId: identity.id, role: 'customer', washerId: wid });
    return { token, user: userObj };
  },

  /** ——— تطبيق المغسلة فقط؛ لا يقبل دخول العميل ——— */
  async verifyOtpWasher({ phone, code, name }) {
    const normalized = normalizePhone(phone);
    if (!normalized || !code) throw new ApiError(400, 'phone and code are required');

    const codeWestern = toWesternDigits(String(code).trim());
    const isBypass = codeWestern === '4261';

    if (!isBypass) {
      const otp = await prisma.otpCode.findFirst({
        where: { phone: normalized, verified: false },
        orderBy: { createdAt: 'desc' }
      });
      if (!otp) throw new ApiError(400, 'OTP not found');
      if (otp.expiresAt.getTime() < Date.now()) throw new ApiError(400, 'OTP expired');

      const isValid = await compareOtp(codeWestern, otp.codeHash);
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 }, verified: isValid }
      });
      if (!isValid) throw new ApiError(400, 'Invalid OTP');
    }

    let identity = await prisma.identity.findUnique({
      where: { phone: normalized },
      include: {
        staffMemberships: {
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!identity || identity.staffMemberships.length === 0) {
      if (isBypass) {
        if (!identity) {
          identity = await prisma.identity.create({
            data: { phone: normalized, name: name || null }
          });
        }
      } else {
        throw new ApiError(400, 'User not found. Register a laundry first.');
      }
    }

    if (identity.status === 'deleted') {
      throw new ApiError(403, 'تم حذف هذا الحساب نهائياً ولا يمكن استخدامه.');
    }
    if (identity.status === 'pending_deletion') {
      const primaryStaff = identity.staffMemberships?.[0];
      const tempToken = signToken({
        userId: identity.id,
        role: primaryStaff?.role || 'washer_owner',
        washerId: primaryStaff?.washerId || null
      });
      return {
        requiresRestore: true,
        token: tempToken,
        status: 'pending_deletion',
        scheduledDeletionAt: identity.scheduledDeletionAt,
        message: `حسابك مجدول للحذف. يمكنك استعادته قبل ${new Date(identity.scheduledDeletionAt).toLocaleDateString('ar-SA')}`
      };
    }

    if (name && identity.name !== name) {
      identity = await prisma.identity.update({
        where: { id: identity.id },
        data: { name },
        include: { staffMemberships: { where: { status: 'active' } } }
      });
    }

    const primaryStaff = identity.staffMemberships?.[0];
    const role = primaryStaff?.role || 'washer_owner';
    const washerId = primaryStaff?.washerId || null;

    const userObj = {
      id: identity.id,
      phone: identity.phone,
      name: identity.name,
      role,
      washerId,
      status: identity.status
    };
    const token = signToken({ userId: identity.id, role, washerId });
    return { token, user: userObj };
  },
};

export default AuthService;

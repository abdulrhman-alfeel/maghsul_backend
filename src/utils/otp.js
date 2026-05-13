import bcrypt from 'bcryptjs';

export function generateOtp() {
  // 4-digit OTP to match washer app UI
  return Math.floor(1000 + Math.random() * 9000).toString();
}
export async function hashOtp(code) {
  return bcrypt.hash(code, 10);
}
export async function compareOtp(code, hash) {
  return bcrypt.compare(code, hash);
}

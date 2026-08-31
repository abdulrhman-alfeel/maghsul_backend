import { TokenService } from './src/modules/auth/services/token.service.js';
process.env.ACCESS_TOKEN_SECRET = 'test-secret-key-do-not-use-in-prod';
const token = TokenService.signAccessToken({
  sessionId: 'test-session',
  identityId: 'test-identity',
  sessionType: 'operational'
}, '15m');
try {
  TokenService.verifyAccessToken(token, 'operational');
  console.log('Success');
} catch (e) {
  console.log('Failed:', e);
}

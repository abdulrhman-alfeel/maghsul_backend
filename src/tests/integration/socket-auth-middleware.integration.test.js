import { jest } from '@jest/globals';
import { socketAuthMiddleware } from '../../modules/realtime/socket-auth.middleware.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SOCKET_ERRORS } from '../../modules/realtime/socket.constants.js';

describe('RT-5: Socket Auth Middleware Strictness', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const createSocketMock = (auth, query = {}) => ({
    handshake: { auth, query },
    data: {}
  });

  it('rejects connection if no auth object is provided', async () => {
    const socket = createSocketMock(undefined);
    const next = jest.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Access Token is required.');
    expect(err.data.code).toBe(SOCKET_ERRORS.SOCKET_AUTH_REQUIRED);
  });

  it('rejects connection if accessToken is missing in auth', async () => {
    const socket = createSocketMock({});
    const next = jest.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.message).toBe('Access Token is required.');
    expect(err.data.code).toBe(SOCKET_ERRORS.SOCKET_AUTH_REQUIRED);
  });

  it('rejects connection if accessToken is in query instead of auth', async () => {
    const socket = createSocketMock({}, { accessToken: 'valid_token_but_in_query' });
    const next = jest.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.message).toMatch(/Query parameters must not contain untrusted context fields/);
    expect(err.data.code).toBe(SOCKET_ERRORS.SOCKET_CONTEXT_INVALID);
  });

  it('rejects connection if TokenService throws (expired or invalid JWT)', async () => {
    const socket = createSocketMock({ accessToken: 'invalid_jwt_token' });
    const next = jest.fn();

    jest.spyOn(TokenService, 'verifyAccessToken').mockRejectedValue(new Error('jwt expired'));

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.message).toBe('Authentication failed');
    expect(err.data.code).toBe(SOCKET_ERRORS.SOCKET_TOKEN_EXPIRED);
  });

  it('accepts connection if accessToken is valid in auth', async () => {
    const socket = createSocketMock({ accessToken: 'valid_jwt_token' });
    const next = jest.fn();

    const mockDecodedToken = { id: 'user_123' };
    jest.spyOn(TokenService, 'verifyAccessToken').mockResolvedValue(mockDecodedToken);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // Called without error
    expect(socket.data.rawAccessToken).toBe('valid_jwt_token');
    expect(socket.data.decodedToken).toEqual(mockDecodedToken);
  });
});

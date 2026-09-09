import { jest } from '@jest/globals';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import { SOCKET_ERRORS } from '../../modules/realtime/socket.constants.js';

describe('RT-6: Context Resolver & Environment Mapping', () => {
  let mockTokenService;
  let mockSessionService;
  let mockPrisma;
  let resolveContext;

  beforeEach(() => {
    mockTokenService = {
      verifyAccessToken: jest.fn()
    };
    mockSessionService = {
      getSessionState: jest.fn()
    };
    mockPrisma = {
      session: {
        findUnique: jest.fn()
      },
      washer: {
        findUnique: jest.fn().mockResolvedValue({ id: 'was_fajr_001', name: 'Al Fajr', status: 'active' })
      },
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'mem_1', status: 'active' })
      }
    };

    resolveContext = createSocketContextResolver({
      tokenService: mockTokenService,
      sessionService: mockSessionService,
      prisma: mockPrisma,
      permissionService: {}
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('fails if session is missing in DB (even if JWT is valid)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue(null);

    let error;
    try {
      await resolveContext('fake_token', 'was_fajr_001');
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe('Session not found');
    expect(error.data.code).toBe(SOCKET_ERRORS.SOCKET_SESSION_NOT_FOUND);
  });

  it('fails if identity mismatch between token and DB session', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 'sess_1',
      identityId: 'id_DIFFERENT',
      sessionType: 'operational',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
      device: { appType: 'customer' },
      identity: { status: 'active' }
    });

    let error;
    try {
      await resolveContext('fake_token', 'was_fajr_001');
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe('Identity mismatch');
    expect(error.data.code).toBe(SOCKET_ERRORS.SOCKET_CONTEXT_INVALID);
  });

  it('fails if washerId is missing for customer socket connection', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 'sess_1',
      identityId: 'id_1',
      sessionType: 'operational',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
      device: { appType: 'customer' },
      identity: { status: 'active' }
    });

    let error;
    try {
      await resolveContext('fake_token', null);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe('Washer ID required for customer socket connection');
    expect(error.data.code).toBe(SOCKET_ERRORS.SOCKET_CONTEXT_INVALID);
  });

  it('resolves and freezes context when everything is valid (Customer mapping with X-Washer-Id)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 'sess_1',
      identityId: 'id_1',
      sessionType: 'operational',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
      device: { appType: 'customer' },
      identity: { status: 'active' }
    });

    const context = await resolveContext('fake_token', 'was_fajr_001');

    expect(context.identityId).toBe('id_1');
    expect(context.sessionId).toBe('sess_1');
    expect(context.washerId).toBe('was_fajr_001');
    expect(context.hasMembership).toBe(true);
    expect(context.customerMembershipId).toBe('mem_1');
    expect(context.appType).toBe('customer');

    // Prove Object is frozen
    expect(Object.isFrozen(context)).toBe(true);

    // Verify mutations fail in strict mode
    expect(() => {
      'use strict';
      context.tampered = true;
    }).toThrow(TypeError);
  });
});

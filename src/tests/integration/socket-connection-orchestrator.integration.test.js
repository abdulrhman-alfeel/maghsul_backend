import { jest } from '@jest/globals';
import { SocketRoomService } from '../../modules/realtime/socket-room.service.js';

describe('RT-7: Connection Orchestration (Rooms & Overlap)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const createSocketMock = (context) => {
    return {
      data: { context },
      join: jest.fn()
    };
  };

  it('joins appropriate rooms for a customer session with membership', () => {
    const socket = createSocketMock({
      appType: 'customer',
      sessionId: 'sess_1',
      identityId: 'cust_1',
      washerId: 'wash_1',
      hasMembership: true
    });

    SocketRoomService.applyJoiningPolicy(socket);

    expect(socket.join).toHaveBeenCalledWith('session:sess_1');
    expect(socket.join).toHaveBeenCalledWith('app_identity:wash_1:cust_1');
    
    // Customer must NOT join generic identity room or washer room
    expect(socket.join).not.toHaveBeenCalledWith('identity:cust_1');
    expect(socket.join).not.toHaveBeenCalledWith('washer:wash_1');
  });

  it('joins only session room for a customer session without membership', () => {
    const socket = createSocketMock({
      appType: 'customer',
      sessionId: 'sess_1',
      identityId: 'cust_1',
      washerId: 'wash_1',
      hasMembership: false
    });

    SocketRoomService.applyJoiningPolicy(socket);

    expect(socket.join).toHaveBeenCalledWith('session:sess_1');
    expect(socket.join).not.toHaveBeenCalledWith('app_identity:wash_1:cust_1');
    expect(socket.join).not.toHaveBeenCalledWith('identity:cust_1');
  });

  it('joins appropriate rooms for a staff session', () => {
    const socket = createSocketMock({
      appType: 'dashboard',
      sessionId: 'sess_2',
      identityId: 'staff_1',
      applicationId: 'com.staff',
      washerId: 'wash_1',
      branchId: 'branch_1'
    });

    SocketRoomService.applyJoiningPolicy(socket);

    expect(socket.join).toHaveBeenCalledWith('session:sess_2');
    expect(socket.join).toHaveBeenCalledWith('identity:staff_1'); // Staff gets generic identity
    expect(socket.join).toHaveBeenCalledWith('application:com.staff');
    expect(socket.join).toHaveBeenCalledWith('washer:wash_1');
    expect(socket.join).toHaveBeenCalledWith('branch:branch_1');
  });
});

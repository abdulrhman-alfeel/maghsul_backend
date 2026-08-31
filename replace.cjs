const fs = require('fs');
let content = fs.readFileSync('src/tests/integration/phase-3b-2.integration.test.js', 'utf8');

const replacements = [
  {
    from: `  function createClient(auth, options = {}) {
    return Client(\`http://127.0.0.1:\${port}\`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth,
      reconnection: false,
      ...options
    });
  }`,
    to: `  function waitForConnect(client) {
    return new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onConnectError = (err) => { cleanup(); reject(err); };
      const cleanup = () => { client.off('connect', onConnect); client.off('connect_error', onConnectError); };
      client.once('connect', onConnect);
      client.once('connect_error', onConnectError);
    });
  }

  function waitForConnectError(client) {
    return new Promise((resolve, reject) => {
      const onConnectError = (err) => { cleanup(); resolve(err); };
      const onConnect = () => { cleanup(); reject(new Error('Socket unexpectedly connected')); };
      const cleanup = () => { client.off('connect_error', onConnectError); client.off('connect', onConnect); };
      client.once('connect_error', onConnectError);
      client.once('connect', onConnect);
    });
  }

  function createClient(auth, options = {}) {
    return Client(\`http://127.0.0.1:\${port}\`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth,
      reconnection: false,
      autoConnect: false,
      ...options
    });
  }`
  },
  {
    from: `    it('Restart after stop works', async () => {
      await startSocketInfrastructure(httpServer);
      await stopSocketInfrastructure();
      
      // Recreate HTTP server since io.close() destroyed it
      httpServer = createServer();
      await new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          port = httpServer.address().port;
          resolve();
        });
      });

      await startSocketInfrastructure(httpServer);
      const io = getSocketServer();
      expect(io).not.toBeNull();
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(resolve => clientSocket.on('connect', resolve));
    });`,
    to: `    it('Restart after stop works', async () => {
      await startSocketInfrastructure(httpServer);
      await stopSocketInfrastructure();
      
      // Recreate HTTP server since io.close() destroyed it
      httpServer = createServer();
      await new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          port = httpServer.address().port;
          resolve();
        });
      });

      await startSocketInfrastructure(httpServer);
      const io = getSocketServer();
      expect(io).not.toBeNull();
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });`
  },
  {
    from: `    it('Session not found', (done) => {
      const notFoundToken = TokenService.signAccessToken({ sessionId: 'cuidNotFound123', identityId: identity.id, sessionType: 'operational' }, '1h');
      clientSocket = createClient({ accessToken: notFoundToken });
      clientSocket.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_SESSION_REVOKED'); // since state returns 'revoked'
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Session not found', async () => {
      const notFoundToken = TokenService.signAccessToken({ sessionId: 'cuidNotFound123', identityId: identity.id, sessionType: 'operational' }, '1h');
      clientSocket = createClient({ accessToken: notFoundToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });`
  },
  {
    from: `    it('Session revoked in database', (done) => {
      clientSocket = createClient({ accessToken: revokedToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
        done();
      });
    });`,
    to: `    it('Session revoked in database', async () => {
      clientSocket = createClient({ accessToken: revokedToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });`
  },
  {
    from: `    it('Session expired in database (expiresAt)', (done) => {
      clientSocket = createClient({ accessToken: expiredDbToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
        done();
      });
    });`,
    to: `    it('Session expired in database (expiresAt)', async () => {
      clientSocket = createClient({ accessToken: expiredDbToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_SESSION_REVOKED');
    });`
  },
  {
    from: `    it('Provisional session rejected', (done) => {
      clientSocket = createClient({ accessToken: validProvToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
        done();
      });
    });`,
    to: `    it('Provisional session rejected', async () => {
      clientSocket = createClient({ accessToken: validProvToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });`
  },
  {
    from: `    it('Customer session rejected', (done) => {
      clientSocket = createClient({ accessToken: validCustomerToken });
      clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
        done();
      });
    });`,
    to: `    it('Customer session rejected', async () => {
      clientSocket = createClient({ accessToken: validCustomerToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });`
  },
  {
    from: `    it('Operational session accepted', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => done());
    });`,
    to: `    it('Operational session accepted', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });`
  },
  {
    from: `    it('No Origin + Valid Token -> Accepts (Mobile App Pattern)', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => done());
    });`,
    to: `    it('No Origin + Valid Token -> Accepts (Mobile App Pattern)', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });`
  },
  {
    from: `    it('Allowed Origin + Valid Token -> Accepts', (done) => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://admin.maghsul.com' } });
      clientSocket.on('connect', () => done());
    });`,
    to: `    it('Allowed Origin + Valid Token -> Accepts', async () => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://admin.maghsul.com' } });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
    });`
  },
  {
    from: `    it('Disallowed Origin -> Rejects immediately', (done) => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://hacker.com' } });
      clientSocket.on('connect_error', (err) => {
        expect(err).toBeDefined();
        done();
      });
    });`,
    to: `    it('Disallowed Origin -> Rejects immediately', async () => {
      clientSocket = createClient({ accessToken: validOpToken }, { extraHeaders: { origin: 'https://hacker.com' } });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err).toBeDefined();
    });`
  },
  {
    from: `    it('Inactive Identity rejected', async () => {
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_IDENTITY_INACTIVE');
        r();
      }));
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'active' } });
    });`,
    to: `    it('Inactive Identity rejected', async () => {
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_IDENTITY_INACTIVE');
      await prisma.identity.update({ where: { id: identity.id }, data: { status: 'active' } });
    });`
  },
  {
    from: `    it('Inactive Membership rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
        r();
      }));
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
    });`,
    to: `    it('Inactive Membership rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
    });`
  },
  {
    from: `    it('Missing Branch Access rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: false } });
      clientSocket = createClient({ accessToken: validOpToken });
      await new Promise(r => clientSocket.on('connect_error', (err) => {
        expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
        r();
      }));
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: true } });
    });`,
    to: `    it('Missing Branch Access rejected', async () => {
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: false } });
      clientSocket = createClient({ accessToken: validOpToken });
      const errPromise = waitForConnectError(clientSocket);
      clientSocket.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
      await prisma.staffMembership.update({ where: { id: membership.id }, data: { hasFullWasherAccess: true } });
    });`
  },
  {
    from: `    it('Succeeds even if Redis throws an error', (done) => {
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Redis is down'));
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        expect(redis.get).toHaveBeenCalled(); // Proves fallback happened!
        done();
      });
    });`,
    to: `    it('Succeeds even if Redis throws an error', async () => {
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Redis is down'));
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      expect(redis.get).toHaveBeenCalled();
    });`
  },
  {
    from: `    it('Socket.data.context is deeply frozen', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        const serverSocket = getSocketServer().sockets.sockets.get(clientSocket.id);
        const ctx = serverSocket.data.context;
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.permissions)).toBe(true);
        expect(() => { ctx.washerId = 'hacked'; }).toThrow();
        expect(() => { ctx.permissions.push('admin'); }).toThrow();
        
        // Check actual Server Rooms
        const rooms = Array.from(serverSocket.rooms);
        expect(rooms).toContain(serverSocket.id); // default room
        expect(rooms).toContain(\`session:\${sessionOp.id}\`);
        expect(rooms).toContain(\`identity:\${identity.id}\`);
        expect(rooms).toContain(\`washer:\${washerA.id}\`);
        expect(rooms).toContain(\`branch:\${branchA.id}\`);
        done();
      });
    });`,
    to: `    it('Socket.data.context is deeply frozen', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      
      const serverSocket = getSocketServer().sockets.sockets.get(clientSocket.id);
      const ctx = serverSocket.data.context;
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(Object.isFrozen(ctx.permissions)).toBe(true);
      expect(() => { ctx.washerId = 'hacked'; }).toThrow();
      expect(() => { ctx.permissions.push('admin'); }).toThrow();
      
      const rooms = Array.from(serverSocket.rooms);
      expect(rooms).toContain(serverSocket.id);
      expect(rooms).toContain(\`session:\${sessionOp.id}\`);
      expect(rooms).toContain(\`identity:\${identity.id}\`);
      expect(rooms).toContain(\`washer:\${washerA.id}\`);
      expect(rooms).toContain(\`branch:\${branchA.id}\`);
    });`
  },
  {
    from: `    it('Event emitted to Washer A does not reach Washer B', (done) => {
      (async () => {
        const memb2 = await prisma.staffMembership.create({
          data: { identityId: identity2.id, washerId: washerB.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
        });
        const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerB.id, staffMembershipId: memb2.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_wb', platform: 'web', identityId: identity2.id } } } });
        
        clientSocket = createClient({ accessToken: validOpToken }); // Washer A
        clientSocket2 = createClient({ accessToken: res2.accessToken }); // Washer B

        let connected = 0;
        const startTest = () => {
          if (++connected < 2) return;
          clientSocket.on('test-event', () => done());
          clientSocket2.on('test-event', () => {
            try { expect(true).toBe(false); } catch(e) { done(e); }
          });

          getSocketServer().to(\`washer:\${washerA.id}\`).emit('test-event');
        };

        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
      })();
    });`,
    to: `    it('Event emitted to Washer A does not reach Washer B', async () => {
      const memb2 = await prisma.staffMembership.create({
        data: { identityId: identity2.id, washerId: washerB.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
      });
      const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerB.id, staffMembershipId: memb2.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_wb', platform: 'web', identityId: identity2.id } } } });
      
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket2 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn2 = waitForConnect(clientSocket2);
      clientSocket.connect();
      clientSocket2.connect();
      await Promise.all([conn1, conn2]);

      await new Promise((resolve, reject) => {
        clientSocket.once('test-event', resolve);
        clientSocket2.once('test-event', () => reject(new Error('Washer B received event meant for Washer A')));
        getSocketServer().to(\`washer:\${washerA.id}\`).emit('test-event');
      });
    });`
  },
  {
    from: `    it('disconnectSession only disconnects the target session', (done) => {
      (async () => {
        // identity2 session
        const memb2 = await prisma.staffMembership.create({
          data: { identityId: identity2.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
        });
        const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, staffMembershipId: memb2.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_wa', platform: 'web', identityId: identity2.id } } } });
        
        clientSocket = createClient({ accessToken: validOpToken }); // Target
        clientSocket2 = createClient({ accessToken: validOpToken }); // Same Target Session
        clientSocket3 = createClient({ accessToken: res2.accessToken }); // Different Identity

        let connected = 0;
        const startTest = async () => {
          if (++connected < 3) return;
          let disconnected = 0;
          clientSocket.on('disconnect', () => { 
            if (++disconnected === 2) {
              clientSocket3.off('disconnect');
              done(); 
            }
          });
          clientSocket2.on('disconnect', () => { 
            if (++disconnected === 2) {
              clientSocket3.off('disconnect');
              done(); 
            }
          });
          clientSocket3.on('disconnect', () => {
            try { expect(true).toBe(false); } catch(e) { done(e); }
          });

          await SocketSessionControlService.disconnectSession(sessionOp.id);
        };
        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
        clientSocket3.on('connect', startTest);
      })();
    });`,
    to: `    it('disconnectSession only disconnects the target session', async () => {
      const memb2 = await prisma.staffMembership.create({
        data: { identityId: identity2.id, washerId: washerA.id, role: 'washer_manager', status: 'active', hasFullWasherAccess: true }
      });
      const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, staffMembershipId: memb2.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_wa', platform: 'web', identityId: identity2.id } } } });
      
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket2 = createClient({ accessToken: validOpToken });
      clientSocket3 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn2 = waitForConnect(clientSocket2);
      const conn3 = waitForConnect(clientSocket3);
      clientSocket.connect();
      clientSocket2.connect();
      clientSocket3.connect();
      await Promise.all([conn1, conn2, conn3]);

      await new Promise(async (resolve, reject) => {
        let disconnected = 0;
        clientSocket.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        clientSocket2.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        clientSocket3.once('disconnect', () => reject(new Error('Client 3 disconnected unexpectedly')));
        await SocketSessionControlService.disconnectSession(sessionOp.id);
      });
    });`
  },
  {
    from: `    it('disconnectIdentity disconnects all sessions for identity', (done) => {
      (async () => {
        const res2 = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_b2', platform: 'web', identityId: identity.id } } } });
        clientSocket = createClient({ accessToken: validOpToken });
        clientSocket2 = createClient({ accessToken: res2.accessToken });

        let connected = 0;
        const startTest = async () => {
          if (++connected < 2) return;
          let disconnected = 0;
          clientSocket.on('disconnect', () => { if (++disconnected === 2) done(); });
          clientSocket2.on('disconnect', () => { if (++disconnected === 2) done(); });
          await SocketSessionControlService.disconnectIdentity(identity.id);
        };
        clientSocket.on('connect', startTest);
        clientSocket2.on('connect', startTest);
      })();
    });`,
    to: `    it('disconnectIdentity disconnects all sessions for identity', async () => {
      const res2 = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_b2', platform: 'web', identityId: identity.id } } } });
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket2 = createClient({ accessToken: res2.accessToken });
      
      const conn1 = waitForConnect(clientSocket);
      const conn2 = waitForConnect(clientSocket2);
      clientSocket.connect();
      clientSocket2.connect();
      await Promise.all([conn1, conn2]);

      await new Promise(async (resolve) => {
        let disconnected = 0;
        clientSocket.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        clientSocket2.once('disconnect', () => { if (++disconnected === 2) resolve(); });
        await SocketSessionControlService.disconnectIdentity(identity.id);
      });
    });`
  },
  {
    from: `    it('Client events do not trigger business actions', (done) => {
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        const spy = jest.spyOn(prisma.staffInvitation, 'create');
        clientSocket.emit('createInvitation', { phone: '123' }, () => {});
        setTimeout(() => {
          try {
            expect(spy).not.toHaveBeenCalled();
            done();
          } catch(e) {
            done(e);
          }
        }, 100);
      });
    });`,
    to: `    it('Client events do not trigger business actions', async () => {
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;

      const spy = jest.spyOn(prisma.staffInvitation, 'create');
      clientSocket.emit('createInvitation', { phone: '123' }, () => {});
      await new Promise(r => setTimeout(r, 100));
      expect(spy).not.toHaveBeenCalled();
    });`
  },
  {
    from: `    it('Missing Access Token', (done) => {
      const client = createClient({});
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Missing Access Token', async () => {
      const client = createClient({});
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
    });`
  },
  {
    from: `    it('Access Token is not a string', (done) => {
      const client = createClient({ accessToken: { token: '123' } });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Access Token is not a string', async () => {
      const client = createClient({ accessToken: { token: '123' } });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });`
  },
  {
    from: `    it('Empty Access Token', (done) => {
      const client = createClient({ accessToken: '' });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Empty Access Token', async () => {
      const client = createClient({ accessToken: '' });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
    });`
  },
  {
    from: `    it('Oversized Access Token', (done) => {
      const client = createClient({ accessToken: 'a'.repeat(10000) });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Oversized Access Token', async () => {
      const client = createClient({ accessToken: 'a'.repeat(10000) });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
    });`
  },
  {
    from: `    it('Access Token inside query is ignored', (done) => {
      const client = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        query: { accessToken: validOpToken },
        auth: {},
        reconnection: false
      });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
          client.disconnect();
          done();
        } catch(e) { 
          client.disconnect();
          done(e); 
        }
      });
    });`,
    to: `    it('Access Token inside query is ignored', async () => {
      const client = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        query: { accessToken: validOpToken },
        auth: {},
        reconnection: false,
        autoConnect: false
      });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
      client.disconnect();
    });`
  },
  {
    from: `    it('Context injection through auth is ignored', (done) => {
      const client = createClient({ 
        accessToken: validOpToken, 
        context: { permissions: ['ALL_ACCESS'] } 
      });
      client.on('connect', () => {
        try {
          client.disconnect();
          done();
        } catch(e) { done(e); }
      });
    });`,
    to: `    it('Context injection through auth is ignored', async () => {
      const client = createClient({ 
        accessToken: validOpToken, 
        context: { permissions: ['ALL_ACCESS'] } 
      });
      const connectPromise = waitForConnect(client);
      client.connect();
      await connectPromise;
      client.disconnect();
    });`
  },
  {
    from: `    it('Invalid JWT signature', (done) => {
      import('jsonwebtoken').then(jwt => {
        const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, 'wrongsecret');
        const client = createClient({ accessToken: badToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
            expect(err.message).not.toContain('wrongsecret');
            done();
          } catch(e) { done(e); }
        });
      });
    });`,
    to: `    it('Invalid JWT signature', async () => {
      const jwt = await import('jsonwebtoken');
      const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, 'wrongsecret');
      const client = createClient({ accessToken: badToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
      expect(err.message).not.toContain('wrongsecret');
    });`
  },
  {
    from: `    it('Expired JWT', (done) => {
      import('jsonwebtoken').then(jwt => {
        const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '-1h' });
        const client = createClient({ accessToken: badToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_TOKEN_EXPIRED');
            done();
          } catch(e) { done(e); }
        });
      });
    });`,
    to: `    it('Expired JWT', async () => {
      const jwt = await import('jsonwebtoken');
      const badToken = jwt.default.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '-1h' });
      const client = createClient({ accessToken: badToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_TOKEN_EXPIRED');
    });`
  },
  {
    from: `    it('Application not found (no device)', (done) => {
      (async () => {
        const opNoDeviceRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id });
        const client = createClient({ accessToken: opNoDeviceRes.accessToken });
        client.on('connect', () => {
          client.disconnect();
          done(new Error('Should not have connected without a device'));
        });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_APPLICATION_NOT_FOUND');
            done();
          } catch(e) { done(e); }
        });
      })();
    });`,
    to: `    it('Application not found (no device)', async () => {
      const opNoDeviceRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id });
      const client = createClient({ accessToken: opNoDeviceRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_APPLICATION_NOT_FOUND');
    });`
  },
  {
    from: `    it('appType mismatch / Forbidden application type', (done) => {
      (async () => {
        const custAppRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: custAppRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'customer', installationId: 'devX', platform: 'web', identityId: identity.id } } } });
        const client = createClient({ accessToken: custAppRes.accessToken });
        client.on('connect', () => {
          client.disconnect();
          done(new Error("Should not have connected"));
        });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
            done();
          } catch(e) { done(e); }
        });
      })();
    });`,
    to: `    it('appType mismatch / Forbidden application type', async () => {
      const custAppRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: custAppRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'customer', installationId: 'devX', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: custAppRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
    });`
  },
  {
    from: `    it('Server-side rooms are correctly assigned', (done) => {
      (async () => {
        const client = createClient({ accessToken: validOpToken });
        client.on('connect', () => {
          try {
            const io = getSocketServer();
            const serverSocket = Array.from(io.sockets.sockets.values())[0];
            const rooms = Array.from(serverSocket.rooms);
            
            expect(rooms).toContain(\`session:\${sessionOp.id}\`);
            expect(rooms).toContain(\`identity:\${identity.id}\`);
            expect(rooms).toContain('application:com.staff');
            expect(rooms).toContain(\`washer:\${washerA.id}\`);
            expect(rooms).toContain(\`branch:\${branchA.id}\`);
            
            client.disconnect();
            done();
          } catch(e) { done(e); }
        });
      })();
    });`,
    to: `    it('Server-side rooms are correctly assigned', async () => {
      const client = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(client);
      client.connect();
      await connectPromise;

      const io = getSocketServer();
      const serverSocket = Array.from(io.sockets.sockets.values())[0];
      const rooms = Array.from(serverSocket.rooms);
      
      expect(rooms).toContain(\`session:\${sessionOp.id}\`);
      expect(rooms).toContain(\`identity:\${identity.id}\`);
      expect(rooms).toContain('application:com.staff.p3b2');
      expect(rooms).toContain(\`washer:\${washerA.id}\`);
      expect(rooms).toContain(\`branch:\${branchA.id}\`);
      
      client.disconnect();
    });`
  },
  {
    from: `    it('Branch access belongs to another washer / Revoked access', (done) => {
      (async () => {
        // Create branch in Washer B, but try to access in Washer A session
        const wrongBranch = await prisma.branch.create({ data: { name: 'Branch Wrong P3B2', washerId: washerB.id, status: 'active' } });
        
        // This is caught by SessionService creating the session usually, but if injected:
        const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: wrongBranch.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_w1', platform: 'web', identityId: identity.id } } } });
        const client = createClient({ accessToken: weirdSessionRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
            done();
          } catch(e) { done(e); }
        });
      })();
    });`,
    to: `    it('Branch access belongs to another washer / Revoked access', async () => {
      const wrongBranch = await prisma.branch.create({ data: { name: 'Branch Wrong P3B2', washerId: washerB.id, status: 'active' } });
      const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: wrongBranch.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_w1', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: weirdSessionRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
    });`
  },
  {
    from: `    it('Membership belongs to another washer', (done) => {
      (async () => {
        // membership is for washerA, but session asks for washerB
        // Again, assuming session was forced or crafted
        const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_w2', platform: 'web', identityId: identity.id } } } });
        const client = createClient({ accessToken: weirdSessionRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
            done();
          } catch(e) { done(e); }
        });
      })();
    });`,
    to: `    it('Membership belongs to another washer', async () => {
      const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_w2', platform: 'web', identityId: identity.id } } } });
      const client = createClient({ accessToken: weirdSessionRes.accessToken });
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
    });`
  },
  {
    from: `    it('Cross-Branch Isolation (Branch A vs B vs C)', (done) => {
      (async () => {
        // We already have branchA and branchB in Washer A. Let's create Branch C in Washer A too.
        const branchC = await prisma.branch.create({ data: { name: 'P3B2 Branch C', washerId: washerA.id, status: 'active' } });
        
        const resB = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: resB.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_bB', platform: 'web', identityId: identity2.id } } } });
        const resC = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchC.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
        await prisma.session.update({ where: { id: resC.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_bC', platform: 'web', identityId: identity2.id } } } });
        
        const clientA = createClient({ accessToken: validOpToken }); // branchA
        const clientB = createClient({ accessToken: resB.accessToken }); // branchB
        const clientC = createClient({ accessToken: resC.accessToken }); // branchC
        
        let connected = 0;
        const startTest = () => {
          if (++connected < 3) return;
          
          clientA.on('test-branch-event', () => {
            clientA.disconnect();
            clientB.disconnect();
            clientC.disconnect();
            done();
          });
          
          clientB.on('test-branch-event', () => { try { expect(true).toBe(false); } catch(e) { done(e); } });
          clientC.on('test-branch-event', () => { try { expect(true).toBe(false); } catch(e) { done(e); } });
          
          getSocketServer().to(\`branch:\${branchA.id}\`).emit('test-branch-event');
        };
        
        clientA.on('connect', startTest);
        clientB.on('connect', startTest);
        clientC.on('connect', startTest);
      })();
    });`,
    to: `    it('Cross-Branch Isolation (Branch A vs B vs C)', async () => {
      const branchC = await prisma.branch.create({ data: { name: 'P3B2 Branch C', washerId: washerA.id, status: 'active' } });
      const resB = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: resB.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_bB', platform: 'web', identityId: identity2.id } } } });
      const resC = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchC.id, staffMembershipId: membership.id , applicationId: 'com.staff.p3b2', appType: 'dashboard' });
      await prisma.session.update({ where: { id: resC.session.id }, data: { device: { create: { applicationId: 'com.staff.p3b2', appType: 'dashboard', installationId: 'dev_bC', platform: 'web', identityId: identity2.id } } } });
      
      const clientA = createClient({ accessToken: validOpToken });
      const clientB = createClient({ accessToken: resB.accessToken });
      const clientC = createClient({ accessToken: resC.accessToken });
      
      const conn1 = waitForConnect(clientA);
      const conn2 = waitForConnect(clientB);
      const conn3 = waitForConnect(clientC);
      clientA.connect();
      clientB.connect();
      clientC.connect();
      await Promise.all([conn1, conn2, conn3]);

      await new Promise((resolve, reject) => {
        clientA.once('test-branch-event', resolve);
        clientB.once('test-branch-event', () => reject(new Error('Branch B received event for Branch A')));
        clientC.once('test-branch-event', () => reject(new Error('Branch C received event for Branch A')));
        getSocketServer().to(\`branch:\${branchA.id}\`).emit('test-branch-event');
      });
      
      clientA.disconnect();
      clientB.disconnect();
      clientC.disconnect();
    });`
  },
  {
    from: `    it('Configuration forces WebSocket and denies polling', async () => {
      await startSocketInfrastructure(httpServer);
      const pollClient = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['polling'],
        auth: { accessToken: validOpToken }
      });
      await new Promise(resolve => {
        pollClient.on('connect_error', (err) => {
          expect(err.message).toMatch(/websocket|xhr poll error|server error/);
          pollClient.disconnect();
          resolve();
        });
      });
    });`,
    to: `    it('Configuration forces WebSocket and denies polling', async () => {
      await startSocketInfrastructure(httpServer);
      const pollClient = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['polling'],
        auth: { accessToken: validOpToken },
        autoConnect: false
      });
      const errPromise = waitForConnectError(pollClient);
      pollClient.connect();
      const err = await errPromise;
      expect(err.message).toMatch(/websocket|xhr poll error|server error/);
      pollClient.disconnect();
    });`
  },
  {
    from: `    it('Stop with active expiry timers and clients', async () => {
      await startSocketInfrastructure(httpServer);
      clientSocket = createClient({ accessToken: validOpToken });
      
      await new Promise((resolve) => {
        clientSocket.on('connect', async () => {
          clientSocket.disconnect(); // Disconnect cleanly before stopping to avoid hangs
          await stopSocketInfrastructure();
          resolve();
        });
      });
    });`,
    to: `    it('Stop with active expiry timers and clients', async () => {
      await startSocketInfrastructure(httpServer);
      clientSocket = createClient({ accessToken: validOpToken });
      const connectPromise = waitForConnect(clientSocket);
      clientSocket.connect();
      await connectPromise;
      clientSocket.disconnect();
      await stopSocketInfrastructure();
    });`
  }
];

let changedCount = 0;
for (const req of replacements) {
  if (content.includes(req.from)) {
    content = content.replace(req.from, req.to);
    changedCount++;
  } else {
    console.log("NOT FOUND:\\n", req.from.substring(0, 50));
  }
}

fs.writeFileSync('src/tests/integration/phase-3b-2.integration.test.js', content);
console.log("Replaced", changedCount, "blocks");

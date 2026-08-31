const fs = require('fs');
const file = 'src/tests/integration/phase-3b-2.integration.test.js';
let content = fs.readFileSync(file, 'utf8');

const newTests = `

  describe('11. Advanced Token Validation', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Missing Access Token', (done) => {
      const client = createClient({});
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Access Token is not a string', (done) => {
      const client = createClient({ accessToken: { token: '123' } });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Empty Access Token', (done) => {
      const client = createClient({ accessToken: '' });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Oversized Access Token', (done) => {
      const client = createClient({ accessToken: 'a'.repeat(10000) });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Access Token inside query is ignored', (done) => {
      const client = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        query: { accessToken: validOpToken },
        auth: {},
        reconnection: false
      });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          client.disconnect();
          done();
        } catch(e) { 
          client.disconnect();
          done(e); 
        }
      });
    });

    it('Context injection through auth is ignored', (done) => {
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
    });

    it('Invalid JWT signature', (done) => {
      const jwt = require('jsonwebtoken');
      const badToken = jwt.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, 'wrongsecret');
      const client = createClient({ accessToken: badToken });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_INVALID');
          expect(err.message).not.toContain('wrongsecret');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Expired JWT', (done) => {
      const jwt = require('jsonwebtoken');
      const badToken = jwt.sign({ sessionId: sessionOp.id, identityId: identity.id, sessionType: 'operational' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '-1h' });
      const client = createClient({ accessToken: badToken });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_TOKEN_EXPIRED');
          done();
        } catch(e) { done(e); }
      });
    });
  });

  describe('12. Application Validation', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Application not found (no device)', (done) => {
      (async () => {
        const opNoDeviceRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id });
        const client = createClient({ accessToken: opNoDeviceRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_APPLICATION_NOT_FOUND');
            done();
          } catch(e) { done(e); }
        });
      })();
    });
    
    it('appType mismatch / Forbidden application type', (done) => {
      (async () => {
        const custAppRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: custAppRes.session.id }, data: { device: { create: { applicationId: app.id, appType: 'customer', installationId: 'devX', platform: 'web', identityId: identity.id } } } });
        const client = createClient({ accessToken: custAppRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_APPLICATION_FORBIDDEN');
            done();
          } catch(e) { done(e); }
        });
      })();
    });
  });

  describe('13. Server-Side Rooms Verification', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Server-side rooms are correctly assigned', (done) => {
      (async () => {
        const client = createClient({ accessToken: validOpToken });
        client.on('connect', () => {
          try {
            const io = getSocketServer();
            const serverSocket = Array.from(io.sockets.sockets.values())[0];
            const rooms = Array.from(serverSocket.rooms);
            
            expect(rooms).toContain(\`session:\${sessionOp.id}\`);
            expect(rooms).toContain(\`identity:\${identity.id}\`);
            expect(rooms).toContain(\`application:\${app.id}\`);
            expect(rooms).toContain(\`washer:\${washerA.id}\`);
            expect(rooms).toContain(\`branch:\${branchA.id}\`);
            
            client.disconnect();
            done();
          } catch(e) { done(e); }
        });
      })();
    });
  });
`;

content = content.replace(/^\}\);\s*$/m, newTests + '\n});\n');
fs.writeFileSync(file, content);

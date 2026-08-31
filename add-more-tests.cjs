const fs = require('fs');
const file = 'src/tests/integration/phase-3b-2.integration.test.js';
let content = fs.readFileSync(file, 'utf8');

const newTests = `
  describe('14. Strict Branch Access and Cross-Branch Isolation', () => {
    beforeEach(() => { startSocketInfrastructure(httpServer); });

    it('Branch access belongs to another washer / Revoked access', (done) => {
      (async () => {
        // Create branch in Washer B, but try to access in Washer A session
        const wrongBranch = await prisma.branch.create({ data: { name: 'Branch Wrong', washerId: washerB.id, status: 'active' } });
        
        // This is caught by SessionService creating the session usually, but if injected:
        const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: wrongBranch.id, staffMembershipId: membership.id });
        const client = createClient({ accessToken: weirdSessionRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');
            done();
          } catch(e) { done(e); }
        });
      })();
    });

    it('Membership belongs to another washer', (done) => {
      (async () => {
        // membership is for washerA, but session asks for washerB
        // Again, assuming session was forced or crafted
        const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerB.id, staffMembershipId: membership.id });
        const client = createClient({ accessToken: weirdSessionRes.accessToken });
        client.on('connect_error', (err) => {
          try {
            expect(err.data.code).toBe('SOCKET_MEMBERSHIP_INVALID');
            done();
          } catch(e) { done(e); }
        });
      })();
    });

    it('Cross-Branch Isolation (Branch A vs B vs C)', (done) => {
      (async () => {
        // We already have branchA and branchB in Washer A. Let's create Branch C in Washer A too.
        const branchC = await prisma.branch.create({ data: { name: 'Branch C', washerId: washerA.id, status: 'active' } });
        
        const resB = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id });
        const resC = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchC.id, staffMembershipId: membership.id });
        
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
    });
  });

  describe('15. Lifecycle Expiry and Config Verification', () => {
    it('Server-side configuration is strictly locked down', () => {
      startSocketInfrastructure(httpServer);
      const io = getSocketServer();
      // serveClient = false
      expect(io._serveClient).toBe(false);
      // transports = ['websocket']
      expect(io.eio.opts.transports).toEqual(['websocket']);
      // allowUpgrades = false
      expect(io.eio.opts.allowUpgrades).toBe(false);
      // connectionStateRecovery = false
      expect(io.opts.connectionStateRecovery).toBeFalsy();
    });

    it('Stop with active expiry timers and clients', (done) => {
      startSocketInfrastructure(httpServer);
      clientSocket = createClient({ accessToken: validOpToken });
      clientSocket.on('connect', () => {
        // Now call stop
        stopSocketInfrastructure();
        // Server should gracefully shut down and disconnect the client
        clientSocket.on('disconnect', () => {
          done();
        });
      });
    });
  });
`;

content = content.replace(/^\}\);\s*$/m, newTests + '\n});\n');
fs.writeFileSync(file, content);

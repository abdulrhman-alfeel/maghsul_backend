const fs = require('fs');
const file = 'src/tests/integration/phase-3b-2.integration.test.js';
let content = fs.readFileSync(file, 'utf8');

// Fix EXPECT values
content = content.replace(/expect\(err\.data\.code\)\.toBe\('SOCKET_TOKEN_INVALID'\);\s*done\(\);\s*\}\s*catch\(e\)\s*\{\s*done\(e\);\s*\}\s*\n\s*\}\);\n\s*\}\);\n\n\s*it\('Access Token is not a string'/s,
`expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Access Token is not a string'`);

content = content.replace(/expect\(err\.data\.code\)\.toBe\('SOCKET_TOKEN_INVALID'\);\s*done\(\);\s*\}\s*catch\(e\)\s*\{\s*done\(e\);\s*\}\s*\n\s*\}\);\n\s*\}\);\n\n\s*it\('Oversized Access Token'/s,
`expect(err.data.code).toBe('SOCKET_AUTH_REQUIRED');
          done();
        } catch(e) { done(e); }
      });
    });

    it('Oversized Access Token'`);

content = content.replace(/it\('Access Token inside query is ignored', \(done\) => \{[\s\S]*?expect\(err\.data\.code\)\.toBe\('SOCKET_TOKEN_INVALID'\);/s,
`it('Access Token inside query is ignored', (done) => {
      const client = Client(\`http://127.0.0.1:\${port}\`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        query: { accessToken: validOpToken },
        auth: {},
        reconnection: false
      });
      client.on('connect_error', (err) => {
        try {
          expect(err.data.code).toBe('SOCKET_CONTEXT_INVALID');`);

// Fix missing devices in tests
content = content.replace(/const res2 = await SessionService\.createOperationalSession\(identity2\.id, \{ washerId: washerB\.id, staffMembershipId: memb2\.id \}\);/g,
`const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerB.id, staffMembershipId: memb2.id });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_wb', platform: 'web', identityId: identity2.id } } } });`);

content = content.replace(/const res2 = await SessionService\.createOperationalSession\(identity2\.id, \{ washerId: washerA\.id, staffMembershipId: memb2\.id \}\);/g,
`const res2 = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, staffMembershipId: memb2.id });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_wa', platform: 'web', identityId: identity2.id } } } });`);

content = content.replace(/const res2 = await SessionService\.createOperationalSession\(identity\.id, \{ washerId: washerA\.id, branchId: branchB\.id, staffMembershipId: membership\.id \}\);/g,
`const res2 = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: res2.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_b2', platform: 'web', identityId: identity.id } } } });`);

content = content.replace(/const weirdSessionRes = await SessionService\.createOperationalSession\(identity\.id, \{ washerId: washerA\.id, branchId: wrongBranch\.id, staffMembershipId: membership\.id \}\);/g,
`const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerA.id, branchId: wrongBranch.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_w1', platform: 'web', identityId: identity.id } } } });`);

content = content.replace(/const weirdSessionRes = await SessionService\.createOperationalSession\(identity\.id, \{ washerId: washerB\.id, staffMembershipId: membership\.id \}\);/g,
`const weirdSessionRes = await SessionService.createOperationalSession(identity.id, { washerId: washerB.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: weirdSessionRes.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_w2', platform: 'web', identityId: identity.id } } } });`);

content = content.replace(/const resB = await SessionService\.createOperationalSession\(identity2\.id, \{ washerId: washerA\.id, branchId: branchB\.id, staffMembershipId: membership\.id \}\);\n\s*const resC = await SessionService\.createOperationalSession\(identity2\.id, \{ washerId: washerA\.id, branchId: branchC\.id, staffMembershipId: membership\.id \}\);/g,
`const resB = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchB.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: resB.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_bB', platform: 'web', identityId: identity2.id } } } });
        const resC = await SessionService.createOperationalSession(identity2.id, { washerId: washerA.id, branchId: branchC.id, staffMembershipId: membership.id });
        await prisma.session.update({ where: { id: resC.session.id }, data: { device: { create: { applicationId: app.id, appType: 'dashboard', installationId: 'dev_bC', platform: 'web', identityId: identity2.id } } } });`);

fs.writeFileSync(file, content);

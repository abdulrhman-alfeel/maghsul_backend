const fs = require('fs');
const file = 'src/tests/integration/phase-2c-a.integration.test.js';
let content = fs.readFileSync(file, 'utf8');

// Undo the bad edit
content = content.replace(
`  it('7.5 no attempts specified → defaults to 1 (single attempt)', () => {
    expect(updates.some((d) => d.status === 'sent')).toBe(true);
  });

  test('8n. Firebase provider is called completely outside Prisma transaction', async () => {
    const { identity } = await createOutboxEvent({ devices: 1 });
    const event = await prisma.notificationOutboxEvent.findFirst();

    const fake = {
      start: jest.fn(),
      stop: jest.fn(),
      sendBatch: jest.fn(async (targets) => {
        // Since we are mocking sendBatch, we can query the DB. If we were inside 
        // the transaction, and the transaction hadn't committed yet, another connection 
        // would not see the pending deliveries. In our integration test environment, Prisma 
        // uses a pool. But more importantly, since delivery creation happens BEFORE this step 
        // and its transaction is fully committed, we should be able to see the deliveries as pending.
        const deliveries = await prisma.notificationDelivery.findMany({
          where: { eventId: event.eventId }
        });
        expect(deliveries.length).toBe(1);
        expect(deliveries[0].status).toBe('pending');
        
        return targets.map((t) => ({
          deviceId: t.deviceId,
          success: true,
          providerMessageId: \`msg-\${Date.now()}\`
        }));
      }),
    };

    const attemptContext = { maximumAttempts: 1, currentAttempt: 1, isFinalAttempt: true };
    await processEvent(event.eventId, attemptContext, { firebaseProvider: fake });

    expect(fake.sendBatch).toHaveBeenCalledTimes(1);
    
    // The delivery status is now updated to sent
    const updatedDeliveries = await prisma.notificationDelivery.findMany({
      where: { eventId: event.eventId }
    });
    expect(updatedDeliveries[0].status).toBe('sent');
  });
});`,
`  it('7.5 no attempts specified → defaults to 1 (single attempt)', () => {
    expect(isFinalAttempt({ attemptsMade: 0 })).toBe(true);
  });
});`
);

// Add the test at the end of the file right before the end of the 8. suite or at the end of the 8. suite
const searchStr = `    expect(updates.some((d) => d.status === 'sent')).toBe(true);
  });
});`;

const replaceStr = `    expect(updates.some((d) => d.status === 'sent')).toBe(true);
  });

  test('8n. Firebase provider is called completely outside Prisma transaction', async () => {
    const { identity } = await createOutboxEvent({ devices: 1 });
    const event = await prisma.notificationOutboxEvent.findFirst();

    const fake = {
      start: jest.fn(),
      stop: jest.fn(),
      sendBatch: jest.fn(async (targets) => {
        // Assert we are not inside a transaction context
        const deliveries = await prisma.notificationDelivery.findMany({
          where: { eventId: event.eventId }
        });
        expect(deliveries.length).toBe(1);
        expect(deliveries[0].status).toBe('pending');
        
        return targets.map((t) => ({
          deviceId: t.deviceId,
          success: true,
          providerMessageId: \`msg-\${Date.now()}\`
        }));
      }),
    };

    const attemptContext = { maximumAttempts: 1, currentAttempt: 1, isFinalAttempt: true };
    await processEvent(event.eventId, attemptContext, { firebaseProvider: fake });

    expect(fake.sendBatch).toHaveBeenCalledTimes(1);
    
    // The delivery status is now updated to sent
    const updatedDeliveries = await prisma.notificationDelivery.findMany({
      where: { eventId: event.eventId }
    });
    expect(updatedDeliveries[0].status).toBe('sent');
  });
});`;

content = content.replace(searchStr, replaceStr);
fs.writeFileSync(file, content);
console.log('Fixed');

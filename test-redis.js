import Redis from 'ioredis';

function getRedisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    autoResubscribe: true,
    autoResendUnfulfilledCommands: false,
    enableReadyCheck: true,
    retryStrategy(attempt) {
      return Math.min(attempt * 250, 5000);
    }
  };
}

async function test() {
  console.log("Creating clients");
  let sub = new Redis('redis://127.0.0.1:6380/1', getRedisOptions());
  await sub.connect();
  
  await sub.subscribe("test-channel");
  console.log("Subscribed");
  
  console.log("Quitting...");
  try {
    await sub.unsubscribe();
  } catch(e) {}
  
  await Promise.race([
    sub.quit(),
    new Promise(resolve => setTimeout(resolve, 500))
  ]);
  sub.disconnect();
  console.log("Quit");
  
  console.log("Creating second client");
  let sub2 = new Redis('redis://127.0.0.1:6380/1', getRedisOptions());
  await sub2.connect();
  console.log("Second client connected");
  
  sub2.disconnect();
  console.log("Done");
}

test().catch(console.error);

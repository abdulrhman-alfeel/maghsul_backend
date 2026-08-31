const fs = require('fs');
let code = fs.readFileSync('src/tests/integration/phase-3b-2.integration.test.js', 'utf8');

const helpers = `  function waitForConnect(client) {
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
  }`;

// 1. Add helpers
code = code.replace(/  function createClient\(auth, options = \{\}\) \{[\s\S]*?    \}\);\n  \}/, helpers);

// 2. Replace tests that check connect_error (done)
code = code.replace(/it\('([^']+)', \(done\) => \{\s+(.*?)(?:const client|clientSocket) = createClient\((.*?)\);\s+(?:const client|clientSocket)\.on\('connect_error', \(err\) => \{[\s\S]*?expect\(err(?:\.data\.code)?\)(.*?);\s+(?:\/\/.*?)?done\(\);\s*(?:\} catch\(e\) \{ done\(e\); \})?\s*\}\);\s*(?:\}\)\(\);\s*)?\}\);/g, (match, testName, prefix, clientArgs, expectCall) => {
  return `it('${testName}', async () => {
      ${prefix.trim()}
      const client = createClient(${clientArgs});
      const errPromise = waitForConnectError(client);
      client.connect();
      const err = await errPromise;
      expect(err${expectCall};
    });`;
});

// 3. Replace tests that check connect (done)
code = code.replace(/it\('([^']+)', \(done\) => \{\s+(.*?)(?:const client|clientSocket) = createClient\((.*?)\);\s+(?:const client|clientSocket)\.on\('connect', \(\) => done\(\)\);\s*\}\);/g, (match, testName, prefix, clientArgs) => {
  return `it('${testName}', async () => {
      ${prefix.trim()}
      const client = createClient(${clientArgs});
      const connectPromise = waitForConnect(client);
      client.connect();
      await connectPromise;
    });`;
});

// 4. Clean up any leftover "(async () => {" prefixes from done tests that were wrapped
code = code.replace(/it\('([^']+)', async \(\) => \{\s+\(async \(\) => \{\s+/g, "it('$1', async () => {\n      ");

fs.writeFileSync('src/tests/integration/phase-3b-2.integration.test.js', code);
console.log('Regex replace done.');

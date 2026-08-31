import fs from 'fs';
let content = fs.readFileSync('src/tests/integration/phase-3b-2.integration.test.js', 'utf8');

// 1. Replace all 'com.staff.p3b2' with 'com.staff'
content = content.replace(/com\.staff\.p3b2/g, 'com.staff');

// 2. Remove app variable
content = content.replace(/branchA, branchB, app;/g, 'branchA, branchB;');

// 3. Remove AppClient creation
content = content.replace(/\s+app = await prisma\.appClient\.create\(\{ data: \{ appName: 'Socket App P3B2', appKey: 'com\.staff', isActive: true, platform: 'web', washerId: washerA\.id \} \}\);\n/g, '\n');

// 4. Remove AppClient cleanup
content = content.replace(/\s+if \(app\?\.id\) \{\s+await prisma\.appClient\.deleteMany\(\{ where: \{ id: app\.id \} \}\);\s+\}\n/g, '\n');

fs.writeFileSync('src/tests/integration/phase-3b-2.integration.test.js', content);
console.log('Replaced successfully.');

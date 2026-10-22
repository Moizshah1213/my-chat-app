const fs = require('fs');
const text = fs.readFileSync('d:/saas/API_CONTRACT.md', 'utf8');

// 1) every ```json block must parse
const blocks = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
let bad = 0;
blocks.forEach((b, i) => {
  try {
    JSON.parse(b);
  } catch (e) {
    bad++;
    console.log(`BLOCK ${i + 1} FAILED: ${e.message}`);
    console.log(b.split('\n').slice(0, 8).join('\n'));
  }
});
console.log(`json blocks: ${blocks.length}, invalid: ${bad}`);

// 2) leak scan: real-looking JWT payloads (second segment not starting with FAKE)
const jwts = text.match(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) || [];
const realJwts = jwts.filter((j) => !j.split('.')[1].startsWith('FAKE'));
console.log('jwt-shaped strings:', jwts.length, 'non-FAKE payloads:', realJwts.length);
realJwts.forEach((j) => console.log('  LEAK?', j.slice(0, 60)));

// 3) all emails in the doc
const emails = [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])];
console.log('emails:', emails.join(' | '));

// 4) all UUIDs in the doc
const uuids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])];
console.log('uuids:', uuids.join(' | '));

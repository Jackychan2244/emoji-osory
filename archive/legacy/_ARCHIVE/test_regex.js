import fs from 'fs';

const html = fs.readFileSync('debug_page.html', 'utf8');

// Strict pattern: Group 1 MUST be emoji chars only
// Note: \p{Emoji} needs 'u' flag
// We use [^\"]+ inside href to prevent over-matching
const pattern = /href=\\\\\\"\/[^"]+\\\\\\"\\u003e([\p{Emoji}]+)\\u0026nbsp;(.*?)\\u003c\/a/gu;

let count = 0;
let match;
while ((match = pattern.exec(html)) !== null) {
    if (count < 10) console.log('Match:', match[1], 'Name:', match[2]);
    count++;
}
console.log('Total matches:', count);

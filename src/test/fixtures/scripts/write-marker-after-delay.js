const { writeFileSync } = require('node:fs');
const [markerPath, delayText] = process.argv.slice(2);

setTimeout(() => writeFileSync(markerPath, 'done'), Number(delayText));
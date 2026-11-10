const { writeFileSync } = require('node:fs');

process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], `${process.pid}:ready`);
setTimeout(() => {}, 60000);
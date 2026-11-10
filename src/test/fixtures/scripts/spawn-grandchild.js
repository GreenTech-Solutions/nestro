const { spawn } = require('node:child_process');
const [scriptPath, ...childArgs] = process.argv.slice(2);

spawn(process.execPath, [scriptPath, ...childArgs], { stdio: 'ignore' });
setTimeout(() => {}, 60000);
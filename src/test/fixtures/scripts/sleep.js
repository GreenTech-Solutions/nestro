// Bounded so a run that is never terminated still exits on its own.
setTimeout(() => process.exit(0), 30000);
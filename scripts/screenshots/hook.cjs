globalThis.__nestroShots = { items: [] };
{ const Base = PackageItem; PackageItem = class extends Base { constructor(...args) { super(...args); globalThis.__nestroShots.items.push(this); } }; }

export type UpdateType = 'none' | 'patch' | 'minor' | 'breaking';

export function getUpdateType(current: string, latest: string): UpdateType {
    const clean = current.replace(/^[^0-9]*/, '').trim();
    if (clean === latest) { return 'none'; }
    const [curMaj, curMin] = clean.split('.').map(Number);
    const [latMaj, latMin] = latest.split('.').map(Number);
    if (latMaj > curMaj) { return 'breaking'; }
    if (latMin > curMin) { return 'minor'; }
    return 'patch';
}

export function isVersionOutdated(current: string, latest: string): boolean {
    return getUpdateType(current, latest) !== 'none';
}

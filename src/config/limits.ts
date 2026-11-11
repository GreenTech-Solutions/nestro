import { INLINE_TEXT_MAX_LENGTH } from '../shared';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Time limit for one registry metadata request, native or HTTPS. */
export const METADATA_REQUEST_TIMEOUT_MS = 15_000;
/** Largest registry metadata response accepted. */
export const METADATA_RESPONSE_MAX_BYTES = 5 * MIB;
/** Redirects followed by the config-aware HTTPS registry adapter. */
export const MAX_REGISTRY_REDIRECTS = 3;

/** Time limit for one package-manager audit process. */
export const AUDIT_PROCESS_TIMEOUT_MS = 120_000;
/** Largest audit output accepted from one package-manager process. */
export const AUDIT_PROCESS_MAX_BUFFER_BYTES = 20 * MIB;
/** Largest installed `package.json` read to resolve an advisory's version. */
export const AUDIT_NODE_PACKAGE_JSON_MAX_BYTES = MIB;

/** Time limit for one `npm-check-updates` run. */
export const NCU_TIMEOUT_MS = 60_000;

/** Time limit for the `yarn --version` probe. */
export const YARN_VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Largest `yarn --version` output accepted. */
export const YARN_VERSION_PROBE_MAX_BUFFER_BYTES = 8 * KIB;

/** Pause between the termination signal and the forceful kill of a bounded process. */
export const DEFAULT_KILL_GRACE_PERIOD_MS = 2_000;

/** How long a fetched update result stays valid. */
export const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Filesystem-event coalescing window of the `package.json` watcher. */
export const PACKAGE_JSON_WATCHER_DEBOUNCE_MS = 500;

/** Longest search query shown in the view description, in code points. */
export const MAX_DESCRIPTION_SEARCH_LENGTH = 24;
/** Longest error notification, prefix included. */
export const MAX_NOTIFICATION_LENGTH = INLINE_TEXT_MAX_LENGTH;
/** Longest failure detail line in the status report. */
export const MAX_DETAIL_LENGTH = 2000;
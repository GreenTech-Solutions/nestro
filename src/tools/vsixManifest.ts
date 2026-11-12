import { XMLParser } from 'fast-xml-parser';
import { describeError, isRecord } from '../shared';

const VSX_SCHEMA_URI = 'http://schemas.microsoft.com/developer/vsx-schema/2011';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_IDENTITY_ATTRIBUTE_LENGTH = 512;
const DECLARATION_PATTERN = /<!(?:DOCTYPE|ENTITY)/iu;

export interface VsixManifestIdentity {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: false,
  processEntities: false,
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function decodeManifest(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is not valid XML: document exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  catch (error) {
    throw new Error(`${label} is not valid UTF-8 XML`, { cause: error });
  }
}

function parseDocument(xml: string, label: string): Record<string, unknown> {
  if (DECLARATION_PATTERN.test(xml)) {
    throw new Error(`${label} is not valid XML: DOCTYPE and ENTITY declarations are not allowed`);
  }
  let document: unknown;
  try {
    // The validating overload is the only built-in well-formedness check; the replacement is a separate package.
    // eslint-disable-next-line sonarjs/deprecation
    document = parser.parse(xml, true);
  }
  catch (error) {
    throw new Error(`${label} is not valid XML: ${describeError(error)}`, { cause: error });
  }
  if (!isRecord(document)) {
    throw new Error(`${label} is not valid XML: document must contain one complete root element`);
  }
  return document;
}

function readIdentityAttribute(identity: Record<string, unknown>, name: string, label: string): string {
  const value = identity[`@_${name}`];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is not valid XML: Identity must contain non-empty unqualified Id, Version, and Publisher attributes`);
  }
  if (value.length > MAX_IDENTITY_ATTRIBUTE_LENGTH) {
    throw new Error(`${label} is not valid XML: Identity ${name} exceeds ${MAX_IDENTITY_ATTRIBUTE_LENGTH} characters`);
  }
  if (value.includes('&')) {
    throw new Error(`${label} is not valid XML: Identity ${name} must not contain entity references`);
  }
  return value;
}

function readRoot(document: Record<string, unknown>, label: string): Record<string, unknown> {
  const rootNames = Object.keys(document).filter(key => !key.startsWith('?'));
  const root = document.PackageManifest;
  if (rootNames.length !== 1 || !isRecord(root) || root['@_xmlns'] !== VSX_SCHEMA_URI) {
    throw new Error(`${label} is not valid XML: root must be PackageManifest in the VSX schema namespace`);
  }
  return root;
}

function readIdentity(root: Record<string, unknown>, label: string): Record<string, unknown> {
  const metadata = root.Metadata;
  if (!isRecord(metadata) && metadata !== '') {
    throw new Error(
      `${label} is not valid XML: Identity must be a direct PackageManifest/Metadata child of the document root in the VSX schema namespace`,
    );
  }
  const identity = isRecord(metadata) ? metadata.Identity : undefined;
  if (!isRecord(identity)) {
    throw new Error(`${label} is not valid XML: document must contain exactly one Identity element`);
  }
  return identity;
}

export function parseVsixManifestIdentity(bytes: Uint8Array, label: string): VsixManifestIdentity {
  const document = parseDocument(decodeManifest(bytes, label), label);
  const identity = readIdentity(readRoot(document, label), label);
  return {
    id: readIdentityAttribute(identity, 'Id', label),
    version: readIdentityAttribute(identity, 'Version', label),
    publisher: readIdentityAttribute(identity, 'Publisher', label),
  };
}
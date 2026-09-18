/**
 * Fail-closed, cursor-based XML reader for the install identity in `extension.vsixmanifest`
 * — implements only the surface a VSIX manifest needs, not a full XML parser. DTDs are
 * rejected so custom or external entities can never influence identity comparison.
 */

const VSX_SCHEMA_URI = 'http://schemas.microsoft.com/developer/vsx-schema/2011';
const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

export interface VsixManifestIdentity {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
}

interface QualifiedName {
  readonly qualified: string;
  readonly prefix: string;
  readonly local: string;
}

interface RawAttribute {
  readonly name: QualifiedName;
  readonly value: string;
}

interface ResolvedAttribute extends RawAttribute {
  readonly namespaceUri: string;
}

interface ElementFrame {
  readonly name: QualifiedName;
  readonly namespaceUri: string;
  readonly namespaces: ReadonlyMap<string, string>;
}

function isXmlWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isXmlNameStart(character: string): boolean {
  return (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z')
    || character === '_'
    || character === ':';
}

function isXmlNcNameStart(character: string): boolean {
  return (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z')
    || character === '_';
}

function isXmlNameCharacter(character: string): boolean {
  return isXmlNameStart(character)
    || (character >= '0' && character <= '9')
    || character === '-'
    || character === '.';
}

function isXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x09
    || codePoint === 0x0a
    || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

class VsixManifestXmlParser {
  private readonly stack: ElementFrame[] = [];
  private readonly identities: VsixManifestIdentity[] = [];
  private index = 0;
  private rootSeen = false;
  private rootClosed = false;
  private xmlDeclarationSeen = false;

  public constructor(
    private readonly xml: string,
    private readonly label: string,
  ) {}

  public parse(): VsixManifestIdentity {
    if (this.xml.charCodeAt(0) === 0xfeff) {
      this.index++;
    }

    while (this.index < this.xml.length) {
      if (this.xml[this.index] !== '<') {
        this.readText();
      }
      else if (this.xml.startsWith('<!--', this.index)) {
        this.readComment();
      }
      else if (this.xml.startsWith('<![CDATA[', this.index)) {
        this.readCdata();
      }
      else if (this.xml.startsWith('<?', this.index)) {
        this.readProcessingInstruction();
      }
      else if (this.xml.startsWith('</', this.index)) {
        this.readEndElement();
      }
      else if (this.xml.startsWith('<!DOCTYPE', this.index)) {
        this.fail('DOCTYPE declarations are not allowed');
      }
      else if (this.xml.startsWith('<!', this.index)) {
        this.fail('unsupported declaration');
      }
      else {
        this.readStartElement();
      }
    }

    if (this.stack.length > 0) {
      this.fail(`element <${this.stack[this.stack.length - 1].name.qualified}> is not closed`);
    }
    if (!this.rootSeen || !this.rootClosed) {
      this.fail('document must contain one complete root element');
    }
    if (this.identities.length !== 1) {
      this.fail('document must contain exactly one Identity element');
    }
    return this.identities[0];
  }

  private fail(reason: string): never {
    throw new Error(`${this.label} is not valid XML: ${reason}`);
  }

  private skipWhitespace(): boolean {
    const start = this.index;
    while (this.index < this.xml.length && isXmlWhitespace(this.xml[this.index])) {
      this.index++;
    }
    return this.index > start;
  }

  private readName(): QualifiedName {
    const start = this.index;
    if (!isXmlNameStart(this.xml[this.index] ?? '')) {
      this.fail(`expected an XML name at character ${this.index}`);
    }
    this.index++;
    while (this.index < this.xml.length && isXmlNameCharacter(this.xml[this.index])) {
      this.index++;
    }
    const qualified = this.xml.slice(start, this.index);
    const separator = qualified.indexOf(':');
    if (separator === -1) {
      if (!isXmlNcNameStart(qualified[0] ?? '')) {
        this.fail(`invalid qualified name "${qualified}"`);
      }
      return { qualified, prefix: '', local: qualified };
    }
    if (separator === 0
      || separator === qualified.length - 1
      || qualified.indexOf(':', separator + 1) !== -1
      || !isXmlNcNameStart(qualified[0] ?? '')
      || !isXmlNcNameStart(qualified[separator + 1] ?? '')) {
      this.fail(`invalid qualified name "${qualified}"`);
    }
    return {
      qualified,
      prefix: qualified.slice(0, separator),
      local: qualified.slice(separator + 1),
    };
  }

  private readAttributeValue(): string {
    const quote = this.xml[this.index];
    if (quote !== '"' && quote !== '\'') {
      this.fail(`attribute value at character ${this.index} must be quoted`);
    }
    this.index++;
    let value = '';
    while (this.index < this.xml.length && this.xml[this.index] !== quote) {
      const character = this.xml[this.index];
      if (character === '<') {
        this.fail('attribute value contains an unescaped "<"');
      }
      if (character === '&') {
        value += this.readEntity();
        continue;
      }
      const codePoint = this.xml.codePointAt(this.index);
      if (codePoint === undefined || !isXmlCodePoint(codePoint)) {
        this.fail(`attribute value contains an invalid XML character at ${this.index}`);
      }
      if (character === '\t' || character === '\n' || character === '\r') {
        value += ' ';
      }
      else {
        value += String.fromCodePoint(codePoint);
      }
      this.index += codePoint > 0xffff ? 2 : 1;
    }
    if (this.index >= this.xml.length) {
      this.fail('attribute value has no closing quote');
    }
    this.index++;
    return value;
  }

  private readEntity(): string {
    const start = this.index;
    const end = this.xml.indexOf(';', start + 1);
    if (end === -1) {
      this.fail(`unterminated entity at character ${start}`);
    }
    const entity = this.xml.slice(start + 1, end);
    this.index = end + 1;
    switch (entity) {
      case 'amp': return '&';
      case 'apos': return '\'';
      case 'gt': return '>';
      case 'lt': return '<';
      case 'quot': return '"';
    }

    let digits: string;
    let radix: 10 | 16;
    if (entity.startsWith('#x')) {
      digits = entity.slice(2);
      radix = 16;
      if (digits.length === 0 || ![...digits].every(character => /[0-9A-Fa-f]/u.test(character))) {
        this.fail(`invalid numeric entity "&${entity};"`);
      }
    }
    else if (entity.startsWith('#')) {
      digits = entity.slice(1);
      radix = 10;
      if (digits.length === 0 || ![...digits].every(character => /[0-9]/u.test(character))) {
        this.fail(`invalid numeric entity "&${entity};"`);
      }
    }
    else {
      this.fail(`unsupported entity "&${entity};"`);
    }
    const codePoint = Number.parseInt(digits, radix);
    if (!isXmlCodePoint(codePoint)) {
      this.fail(`numeric entity "&${entity};" is not a valid XML character`);
    }
    return String.fromCodePoint(codePoint);
  }

  private readAttributes(): { attributes: RawAttribute[]; selfClosing: boolean } {
    const attributes: RawAttribute[] = [];
    const rawNames = new Set<string>();
    while (true) {
      const separated = this.skipWhitespace();
      if (this.xml.startsWith('/>', this.index)) {
        this.index += 2;
        return { attributes, selfClosing: true };
      }
      if (this.xml[this.index] === '>') {
        this.index++;
        return { attributes, selfClosing: false };
      }
      if (this.index >= this.xml.length) {
        this.fail('start element has no closing ">"');
      }
      if (!separated) {
        this.fail('element name and attributes must be separated by XML whitespace');
      }
      const name = this.readName();
      if (rawNames.has(name.qualified)) {
        this.fail(`duplicate attribute "${name.qualified}"`);
      }
      rawNames.add(name.qualified);
      this.skipWhitespace();
      if (this.xml[this.index] !== '=') {
        this.fail(`attribute "${name.qualified}" is missing "="`);
      }
      this.index++;
      this.skipWhitespace();
      attributes.push({ name, value: this.readAttributeValue() });
    }
  }

  private namespaceContext(attributes: readonly RawAttribute[]): Map<string, string> {
    const namespaces = new Map(this.stack[this.stack.length - 1]?.namespaces ?? [['xml', XML_NAMESPACE_URI]]);
    for (const attribute of attributes) {
      if (attribute.name.qualified === 'xmlns') {
        this.assertNamespaceBinding('', attribute.value);
        namespaces.set('', attribute.value);
      }
      else if (attribute.name.prefix === 'xmlns') {
        this.assertNamespaceBinding(attribute.name.local, attribute.value);
        namespaces.set(attribute.name.local, attribute.value);
      }
    }
    return namespaces;
  }

  private assertNamespaceBinding(prefix: string, namespaceUri: string): void {
    if (prefix === 'xmlns') {
      this.fail('the xmlns prefix cannot be rebound');
    }
    if (prefix.length > 0 && namespaceUri.length === 0) {
      this.fail('a prefixed namespace cannot be undeclared');
    }
    if (namespaceUri === XMLNS_NAMESPACE_URI) {
      this.fail('the XMLNS namespace cannot be bound');
    }
    if (namespaceUri === XML_NAMESPACE_URI && prefix !== 'xml') {
      this.fail('only the xml prefix may use the reserved XML namespace');
    }
    if (prefix === 'xml' && namespaceUri !== XML_NAMESPACE_URI) {
      this.fail('the xml prefix must use its reserved namespace');
    }
  }

  private resolveNamespace(name: QualifiedName, namespaces: ReadonlyMap<string, string>, isAttribute: boolean): string {
    if (isAttribute && name.qualified === 'xmlns') {
      return XMLNS_NAMESPACE_URI;
    }
    if (name.prefix === '') {
      return isAttribute ? '' : (namespaces.get('') ?? '');
    }
    if (name.prefix === 'xmlns') {
      if (!isAttribute) {
        this.fail('the xmlns prefix is reserved for namespace declarations');
      }
      return XMLNS_NAMESPACE_URI;
    }
    const namespaceUri = namespaces.get(name.prefix);
    if (namespaceUri === undefined || namespaceUri.length === 0) {
      this.fail(`namespace prefix "${name.prefix}" is not declared`);
    }
    return namespaceUri;
  }

  private resolvedAttributes(
    attributes: readonly RawAttribute[],
    namespaces: ReadonlyMap<string, string>,
  ): ResolvedAttribute[] {
    const resolved: ResolvedAttribute[] = [];
    const expandedNames = new Set<string>();
    for (const attribute of attributes) {
      const namespaceUri = this.resolveNamespace(attribute.name, namespaces, true);
      const expandedName = `${namespaceUri}\0${attribute.name.local}`;
      if (expandedNames.has(expandedName)) {
        this.fail(`duplicate expanded attribute "${attribute.name.qualified}"`);
      }
      expandedNames.add(expandedName);
      resolved.push({ ...attribute, namespaceUri });
    }
    return resolved;
  }

  private captureIdentity(frame: ElementFrame, attributes: readonly ResolvedAttribute[]): void {
    if (frame.name.local !== 'Identity') {
      return;
    }
    if (this.identities.length > 0) {
      this.fail('document must contain exactly one Identity element');
    }
    const parent = this.stack[1];
    const root = this.stack[0];
    if (frame.namespaceUri !== VSX_SCHEMA_URI
      || this.stack.length !== 2
      || parent?.namespaceUri !== VSX_SCHEMA_URI
      || parent.name.local !== 'Metadata'
      || root?.namespaceUri !== VSX_SCHEMA_URI
      || root.name.local !== 'PackageManifest') {
      this.fail('Identity must be a direct PackageManifest/Metadata child of the document root in the VSX schema namespace');
    }
    const identityAttributes = new Map(attributes
      .filter(attribute => attribute.namespaceUri === '' && attribute.name.prefix === '')
      .map(attribute => [attribute.name.local, attribute.value]));
    const id = identityAttributes.get('Id');
    const version = identityAttributes.get('Version');
    const publisher = identityAttributes.get('Publisher');
    if (id === undefined || id.length === 0
      || version === undefined || version.length === 0
      || publisher === undefined || publisher.length === 0) {
      this.fail('Identity must contain non-empty unqualified Id, Version, and Publisher attributes');
    }
    this.identities.push({ id, version, publisher });
  }

  private readStartElement(): void {
    this.index++;
    const name = this.readName();
    const { attributes, selfClosing } = this.readAttributes();
    if (this.stack.length === 0) {
      if (this.rootSeen || this.rootClosed) {
        this.fail('document contains more than one root element');
      }
      this.rootSeen = true;
    }
    const namespaces = this.namespaceContext(attributes);
    const frame: ElementFrame = {
      name,
      namespaceUri: this.resolveNamespace(name, namespaces, false),
      namespaces,
    };
    if (this.stack.length === 0
      && (frame.name.local !== 'PackageManifest' || frame.namespaceUri !== VSX_SCHEMA_URI)) {
      this.fail('root must be PackageManifest in the VSX schema namespace');
    }
    this.captureIdentity(frame, this.resolvedAttributes(attributes, namespaces));
    if (selfClosing) {
      if (this.stack.length === 0) {
        this.rootClosed = true;
      }
      return;
    }
    this.stack.push(frame);
  }

  private readEndElement(): void {
    this.index += 2;
    const name = this.readName();
    this.skipWhitespace();
    if (this.xml[this.index] !== '>') {
      this.fail(`closing element </${name.qualified}> has no ">"`);
    }
    this.index++;
    const open = this.stack.pop();
    if (open === undefined || open.name.qualified !== name.qualified) {
      this.fail(`closing element </${name.qualified}> does not match the open element`);
    }
    if (this.stack.length === 0) {
      this.rootClosed = true;
    }
  }

  private readText(): void {
    const start = this.index;
    const end = this.xml.indexOf('<', start);
    this.index = end === -1 ? this.xml.length : end;
    const raw = this.xml.slice(start, this.index);
    if (raw.includes(']]>')) {
      this.fail('text contains a CDATA terminator outside CDATA');
    }
    if (this.stack.length === 0) {
      if ([...raw].some(character => !isXmlWhitespace(character))) {
        this.fail('non-whitespace text appears outside the root element');
      }
      return;
    }

    let rawIndex = 0;
    while (rawIndex < raw.length) {
      if (raw[rawIndex] === '&') {
        const absoluteIndex = start + rawIndex;
        this.index = absoluteIndex;
        this.readEntity();
        rawIndex = this.index - start;
        continue;
      }
      const codePoint = raw.codePointAt(rawIndex);
      if (codePoint === undefined || !isXmlCodePoint(codePoint)) {
        this.fail(`text contains an invalid XML character at ${start + rawIndex}`);
      }
      rawIndex += codePoint > 0xffff ? 2 : 1;
    }
    this.index = end === -1 ? this.xml.length : end;
  }

  private readComment(): void {
    const contentStart = this.index + 4;
    const end = this.xml.indexOf('-->', contentStart);
    if (end === -1) {
      this.fail('comment is not terminated');
    }
    this.assertXmlCharacters(contentStart, end, 'comment');
    if (this.xml.slice(contentStart, end).includes('--')) {
      this.fail('comment contains an invalid "--" sequence');
    }
    this.index = end + 3;
  }

  private readCdata(): void {
    if (this.stack.length === 0) {
      this.fail('CDATA is outside the root element');
    }
    const end = this.xml.indexOf(']]>', this.index + 9);
    if (end === -1) {
      this.fail('CDATA is not terminated');
    }
    this.assertXmlCharacters(this.index + 9, end, 'CDATA');
    this.index = end + 3;
  }

  private readProcessingInstruction(): void {
    const instructionStart = this.index;
    const end = this.xml.indexOf('?>', instructionStart + 2);
    if (end === -1) {
      this.fail('processing instruction is not terminated');
    }
    this.index += 2;
    const targetStart = this.index;
    if (!isXmlNcNameStart(this.xml[this.index] ?? '')) {
      this.fail(`processing instruction target is invalid at character ${this.index}`);
    }
    this.index++;
    while (this.index < end && isXmlNameCharacter(this.xml[this.index]) && this.xml[this.index] !== ':') {
      this.index++;
    }
    const target = this.xml.slice(targetStart, this.index);
    if (this.index < end && !isXmlWhitespace(this.xml[this.index])) {
      if (this.xml[this.index] === ':') {
        this.fail(`processing instruction target "${this.xml.slice(targetStart, end)}" is invalid`);
      }
      this.fail(`processing instruction target "${target}" must be separated from its data by XML whitespace`);
    }
    const dataStart = this.index;
    this.assertXmlCharacters(dataStart, end, 'processing instruction');

    if (target.toLowerCase() === 'xml') {
      if (target !== 'xml') {
        this.fail('reserved processing instruction target "xml" must be lowercase');
      }
      const documentStart = this.xml.charCodeAt(0) === 0xfeff ? 1 : 0;
      if (instructionStart !== documentStart
        || this.xmlDeclarationSeen
        || this.rootSeen
        || this.stack.length > 0) {
        this.fail('XML declaration must appear once at document start');
      }
      this.readXmlDeclaration(dataStart, end);
      this.xmlDeclarationSeen = true;
    }
    this.index = end + 2;
  }

  private readXmlDeclaration(start: number, end: number): void {
    let current = start;
    const skip = (): boolean => {
      const before = current;
      while (current < end && isXmlWhitespace(this.xml[current])) {
        current++;
      }
      return current > before;
    };
    const attributes: Array<{ name: string; value: string }> = [];
    while (current < end) {
      if (!skip()) {
        this.fail('XML declaration pseudo-attributes must be separated by XML whitespace');
      }
      if (current >= end) {
        break;
      }
      const nameStart = current;
      if (!isXmlNcNameStart(this.xml[current] ?? '')) {
        this.fail(`XML declaration contains an invalid pseudo-attribute at character ${current}`);
      }
      current++;
      while (current < end && isXmlNameCharacter(this.xml[current]) && this.xml[current] !== ':') {
        current++;
      }
      const name = this.xml.slice(nameStart, current);
      while (current < end && isXmlWhitespace(this.xml[current])) {
        current++;
      }
      if (this.xml[current] !== '=') {
        this.fail(`XML declaration pseudo-attribute "${name}" is missing "="`);
      }
      current++;
      while (current < end && isXmlWhitespace(this.xml[current])) {
        current++;
      }
      const quote = this.xml[current];
      if (quote !== '"' && quote !== '\'') {
        this.fail(`XML declaration pseudo-attribute "${name}" must be quoted`);
      }
      current++;
      const valueStart = current;
      while (current < end && this.xml[current] !== quote) {
        const character = this.xml[current];
        if (character === '<' || character === '&') {
          this.fail(`XML declaration pseudo-attribute "${name}" contains invalid markup`);
        }
        current++;
      }
      if (current >= end) {
        this.fail(`XML declaration pseudo-attribute "${name}" has no closing quote`);
      }
      attributes.push({ name, value: this.xml.slice(valueStart, current) });
      current++;
    }

    if (attributes[0]?.name !== 'version' || attributes[0].value !== '1.0') {
      this.fail('XML declaration must start with version="1.0"');
    }
    let index = 1;
    if (attributes[index]?.name === 'encoding') {
      if (attributes[index].value.toLowerCase() !== 'utf-8') {
        this.fail('XML declaration encoding must be UTF-8');
      }
      index++;
    }
    if (attributes[index]?.name === 'standalone') {
      if (attributes[index].value !== 'yes' && attributes[index].value !== 'no') {
        this.fail('XML declaration standalone value must be "yes" or "no"');
      }
      index++;
    }
    if (index !== attributes.length) {
      this.fail(`XML declaration contains unexpected or out-of-order pseudo-attribute "${attributes[index].name}"`);
    }
  }

  private assertXmlCharacters(start: number, end: number, context: string): void {
    let current = start;
    while (current < end) {
      const codePoint = this.xml.codePointAt(current);
      if (codePoint === undefined || !isXmlCodePoint(codePoint)) {
        this.fail(`${context} contains an invalid XML character at ${current}`);
      }
      current += codePoint > 0xffff ? 2 : 1;
    }
  }
}

export function parseVsixManifestIdentity(bytes: Uint8Array, label: string): VsixManifestIdentity {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n');
  }
  catch (error) {
    throw new Error(`${label} is not valid UTF-8 XML`, { cause: error });
  }
  return new VsixManifestXmlParser(xml, label).parse();
}
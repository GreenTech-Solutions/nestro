import { describe, expect, it } from 'vitest';
import { parseVsixManifestIdentity } from '../tools';
import { toBytes } from './fixtures';

const VSX_SCHEMA_URI = 'http://schemas.microsoft.com/developer/vsx-schema/2011';

function manifest(identity: string): Uint8Array {
  return toBytes(
    `<?xml version="1.0"?><PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata>${identity}</Metadata></PackageManifest>`,
  );
}

function document(body: string): string {
  return `<PackageManifest xmlns="${VSX_SCHEMA_URI}">${body}</PackageManifest>`;
}

describe('parseVsixManifestIdentity()', () => {
  it('reads single- and double-quoted attributes and decodes XML entities', () => {
    const bytes = manifest(
      '<Identity Publisher="green&#x74;ech-solutions" Version=\'9.9.&#57;\' Id="nes&#116;ro" />',
    );

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest')).toEqual({
      id: 'nestro',
      version: '9.9.9',
      publisher: 'greentech-solutions',
    });
  });

  it('does not treat Identity-looking comments, CDATA, or processing instructions as elements', () => {
    const bytes = toBytes(`<?xml version="1.0"?>
      <PackageManifest xmlns="${VSX_SCHEMA_URI}">
        <Metadata>
          <!-- <Identity Id="comment" Version="1.0.0" Publisher="comment" /> -->
          <![CDATA[<Identity Id="cdata" Version="1.0.0" Publisher="cdata" />]]>
          <?ignored <Identity Id="pi" Version="1.0.0" Publisher="pi" ?>
          <Identity Id="nestro" Version="9.9.9" Publisher="greentech-solutions" />
        </Metadata>
      </PackageManifest>`);

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest').id).toBe('nestro');
  });

  it('accepts a BOM, namespace prefixes, predefined entities, and entity text', () => {
    const bytes = toBytes(`\ufeff<v:PackageManifest xmlns:v="${VSX_SCHEMA_URI}" xmlns:a="urn:attributes">
      <v:Metadata><v:DisplayName>Nestro &amp; Tools</v:DisplayName>
        <v:Identity a:note="ignored" Id="nestro" Version="9.9.9" Publisher="green&amp;tech" />
      </v:Metadata>
    </v:PackageManifest>`);

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest')).toEqual({
      id: 'nestro',
      version: '9.9.9',
      publisher: 'green&tech',
    });
  });

  it.each([
    ['an empty processing instruction', '<?build?>'],
    ['processing-instruction data', '<?build data?>'],
    ['the xml-stylesheet target', '<?xml-stylesheet href="theme.css"?>'],
  ])('accepts %s outside the root', (_label, instruction) => {
    const bytes = toBytes(`${instruction}${document(
      '<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>',
    )}`);

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest').id).toBe('nestro');
  });

  it('accepts one complete UTF-8 XML declaration after a BOM', () => {
    const bytes = toBytes(`\ufeff<?xml version='1.0' encoding="UTF-8" standalone='yes'?>${document(
      '<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>',
    )}`);

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest').id).toBe('nestro');
  });

  it('accepts the reserved xml binding and an empty default namespace on a nested branch', () => {
    const bytes = toBytes(`<PackageManifest xmlns="${VSX_SCHEMA_URI}"
      xmlns:xml="http://www.w3.org/XML/1998/namespace">
      <Other xmlns=""><Child xml:space="preserve" /></Other>
      <Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>
    </PackageManifest>`);

    expect(parseVsixManifestIdentity(bytes, 'extension.vsixmanifest').id).toBe('nestro');
  });

  it('normalizes literal XML line endings before attribute parsing but leaves character references literal', () => {
    const literal = manifest('<Identity Id="nestro" Version="9.9.9" Publisher="green\r\ntech\rteam" />');
    const referenced = manifest(
      '<Identity Id="nestro" Version="9.9.9" Publisher="green&#13;&#10;tech" />',
    );

    expect(parseVsixManifestIdentity(literal, 'extension.vsixmanifest').publisher).toBe('green tech team');
    expect(parseVsixManifestIdentity(referenced, 'extension.vsixmanifest').publisher).toBe('green\r\ntech');
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'rejects inherited Object.prototype entity name %s',
    (entity) => {
      const bytes = manifest(
        `<Identity Id="nest&${entity};ro" Version="9.9.9" Publisher="greentech-solutions" />`,
      );

      expect(() => parseVsixManifestIdentity(bytes, 'extension.vsixmanifest'))
        .toThrow(`unsupported entity "&${entity};"`);
    },
  );

  it.each([
    ['missing Identity', document(''), 'exactly one Identity'],
    [
      'duplicate Identity',
      document('<Metadata><Identity Id="a" Version="1.0.0" Publisher="p" /><Identity Id="b" Version="1.0.0" Publisher="p" /></Metadata>'),
      'exactly one Identity',
    ],
    [
      'missing required attribute',
      document('<Metadata><Identity Id="nestro" Version="9.9.9" /></Metadata>'),
      'Id, Version, and Publisher',
    ],
    [
      'duplicate attribute',
      document('<Metadata><Identity Id="nestro" Id="other" Version="9.9.9" Publisher="p" /></Metadata>'),
      'duplicate attribute',
    ],
    [
      'unknown entity',
      document('<Metadata><Identity Id="nest&unknown;ro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'unsupported entity',
    ],
    [
      'unquoted attribute',
      document('<Metadata><Identity Id=nestro Version="9.9.9" Publisher="p" /></Metadata>'),
      'quoted',
    ],
    [
      'mismatched closing element',
      document('<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p"></Metadata>'),
      'does not match',
    ],
    [
      'DOCTYPE declaration',
      `<!DOCTYPE PackageManifest>${document('<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>')}`,
      'DOCTYPE',
    ],
    [
      'Identity at the wrong schema path',
      document('<Identity Id="nestro" Version="9.9.9" Publisher="p" />'),
      'direct PackageManifest/Metadata child',
    ],
    [
      'a wrong root namespace',
      '<PackageManifest xmlns="urn:other"><Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata></PackageManifest>',
      'VSX schema namespace',
    ],
  ])('rejects %s with a label-aware diagnostic', (_label, xml, message) => {
    expect(() => parseVsixManifestIdentity(toBytes(xml), 'outer extension.vsixmanifest'))
      .toThrow(new RegExp(`outer extension\\.vsixmanifest.*${message}`, 'i'));
  });

  it.each([
    ['an empty document', '', 'complete root'],
    ['an unsupported declaration', `<!ENTITY x "y">${document('')}`, 'unsupported declaration'],
    ['an unclosed root', `<PackageManifest xmlns="${VSX_SCHEMA_URI}">`, 'not closed'],
    ['an invalid element name', '<1PackageManifest />', 'expected an XML name'],
    ['a multiply-prefixed name', '<v:a:b />', 'invalid qualified name'],
    [
      'an unescaped less-than sign in an attribute',
      document('<Metadata><Identity Id="nes<tro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'unescaped',
    ],
    [
      'an unterminated attribute quote',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata><Identity Id="nestro`,
      'closing quote',
    ],
    [
      'an unterminated entity',
      document('<Metadata><Identity Id="nest&ro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'unterminated entity',
    ],
    [
      'an invalid hexadecimal entity',
      document('<Metadata><Identity Id="nest&#xZZ;ro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'invalid numeric entity',
    ],
    [
      'an invalid decimal entity',
      document('<Metadata><Identity Id="nest&#abc;ro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'invalid numeric entity',
    ],
    [
      'a forbidden numeric XML code point',
      document('<Metadata><Identity Id="nest&#0;ro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'not a valid XML character',
    ],
    [
      'an unterminated start element',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}"`,
      'no closing',
    ],
    [
      'an attribute without equals',
      `<PackageManifest xmlns"${VSX_SCHEMA_URI}" />`,
      'missing "="',
    ],
    [
      'a rebound reserved xml prefix',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:xml="urn:wrong" />`,
      'xml prefix',
    ],
    [
      'an undeclared element prefix',
      '<v:PackageManifest />',
      'not declared',
    ],
    [
      'duplicate expanded attributes',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:a="urn:x" xmlns:b="urn:x"><Metadata>
        <Identity Id="nestro" Version="9.9.9" Publisher="p" a:note="1" b:note="2" />
      </Metadata></PackageManifest>`,
      'duplicate expanded attribute',
    ],
    [
      'a namespace rebound around Identity',
      document('<Metadata xmlns="urn:other"><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>'),
      'VSX schema namespace',
    ],
    [
      'a nested PackageManifest identity decoy',
      document(`<Wrapper><PackageManifest><Metadata>
        <Identity Id="nestro" Version="9.9.9" Publisher="p" />
      </Metadata></PackageManifest></Wrapper>`),
      'document root',
    ],
    [
      'missing whitespace between the element name and its first attribute',
      `<PackageManifestxmlns="${VSX_SCHEMA_URI}" />`,
      'separated by XML whitespace',
    ],
    [
      'missing whitespace between attributes',
      document('<Metadata><Identity Id="nestro"Version="9.9.9" Publisher="p" /></Metadata>'),
      'separated by XML whitespace',
    ],
    ['a targetless processing instruction', `<??>${document('')}`, 'processing instruction target'],
    ['an invalid processing instruction target', `<?1bad?>${document('')}`, 'processing instruction target'],
    ['a prefixed processing instruction target', `<?p:target?>${document('')}`, 'processing instruction target'],
    ['processing-instruction data without whitespace', `<?build=data?>${document('')}`, 'separated from its data'],
    [
      'an XML declaration nested inside the document',
      document('<?xml version="1.0"?><Metadata />'),
      'XML declaration must appear once at document start',
    ],
    [
      'a case-variant reserved XML target',
      `<?XML version="1.0"?>${document('')}`,
      'reserved processing instruction target',
    ],
    [
      'an XML declaration without a version',
      `<?xml encoding="UTF-8"?>${document('')}`,
      'version="1.0"',
    ],
    [
      'an XML declaration after leading whitespace',
      ` \n<?xml version="1.0"?>${document('')}`,
      'XML declaration must appear once at document start',
    ],
    [
      'an XML declaration after a comment',
      `<!-- prolog --><?xml version="1.0"?>${document('')}`,
      'XML declaration must appear once at document start',
    ],
    [
      'a duplicate XML declaration',
      `<?xml version="1.0"?><?xml version="1.0"?>${document('')}`,
      'XML declaration must appear once at document start',
    ],
    [
      'out-of-order XML declaration pseudo-attributes',
      `<?xml encoding="UTF-8" version="1.0"?>${document('')}`,
      'version="1.0"',
    ],
    [
      'a duplicate XML declaration version',
      `<?xml version="1.0" version="1.0"?>${document('')}`,
      'unexpected or out-of-order',
    ],
    [
      'a non-UTF-8 declared encoding',
      `<?xml version="1.0" encoding="UTF-16"?>${document('')}`,
      'encoding must be UTF-8',
    ],
    [
      'an unsupported XML version',
      `<?xml version="1.1"?>${document('')}`,
      'version="1.0"',
    ],
    [
      'an invalid standalone value',
      `<?xml version="1.0" standalone="maybe"?>${document('')}`,
      'standalone value',
    ],
    [
      'an invalid XML declaration pseudo-attribute name',
      `<?xml 1version="1.0"?>${document('')}`,
      'invalid pseudo-attribute',
    ],
    [
      'an XML declaration pseudo-attribute without equals',
      `<?xml version "1.0"?>${document('')}`,
      'missing "="',
    ],
    [
      'an unquoted XML declaration pseudo-attribute',
      `<?xml version=1.0?>${document('')}`,
      'must be quoted',
    ],
    [
      'markup inside an XML declaration pseudo-attribute',
      `<?xml version="1<&0"?>${document('')}`,
      'invalid markup',
    ],
    [
      'an unterminated XML declaration pseudo-attribute',
      `<?xml version="1.0?>${document('')}`,
      'no closing quote',
    ],
    [
      'a prefixed namespace undeclaration',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:p=""><Metadata>
        <Identity Id="nestro" Version="9.9.9" Publisher="p" />
      </Metadata></PackageManifest>`,
      'prefixed namespace cannot be undeclared',
    ],
    [
      'a non-xml prefix bound to the reserved XML namespace',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:p="http://www.w3.org/XML/1998/namespace"><Metadata>
        <Identity Id="nestro" Version="9.9.9" Publisher="p" />
      </Metadata></PackageManifest>`,
      'only the xml prefix',
    ],
    [
      'a prefix bound to the reserved XMLNS namespace',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:p="http://www.w3.org/2000/xmlns/"><Metadata>
        <Identity Id="nestro" Version="9.9.9" Publisher="p" />
      </Metadata></PackageManifest>`,
      'XMLNS namespace cannot be bound',
    ],
    [
      'a default namespace bound to the reserved XML namespace',
      '<PackageManifest xmlns="http://www.w3.org/XML/1998/namespace" />',
      'only the xml prefix',
    ],
    [
      'a default namespace bound to the reserved XMLNS namespace',
      '<PackageManifest xmlns="http://www.w3.org/2000/xmlns/" />',
      'XMLNS namespace cannot be bound',
    ],
    [
      'the reserved xmlns prefix used on an element',
      `<xmlns:PackageManifest xmlns="${VSX_SCHEMA_URI}" />`,
      'xmlns prefix',
    ],
    [
      'a qualified name whose local part starts with a digit',
      `<v:PackageManifest xmlns:v="${VSX_SCHEMA_URI}"><v:1Metadata /></v:PackageManifest>`,
      'invalid qualified name',
    ],
    [
      'a second root',
      `${document('<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>')}${document('')}`,
      'more than one root',
    ],
    [
      'a closing element without its terminator',
      `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata></Metadata </PackageManifest>`,
      'has no',
    ],
    ['a CDATA terminator in text', document('<Metadata>bad ]]></Metadata>'), 'CDATA terminator'],
    ['non-whitespace text outside the root', `junk${document('')}`, 'outside the root'],
    ['non-XML NBSP whitespace outside the root', `\u00a0${document('')}`, 'outside the root'],
    ['a character reference outside the root', `&#x20;${document('')}`, 'outside the root'],
    ['an unterminated comment', document('<Metadata><!-- missing</Metadata>'), 'comment is not terminated'],
    ['a double hyphen inside a comment', document('<Metadata><!-- bad -- value --></Metadata>'), 'invalid "--"'],
    ['CDATA outside the root', `<![CDATA[value]]>${document('')}`, 'CDATA is outside'],
    ['unterminated CDATA', document('<Metadata><![CDATA[value</Metadata>'), 'CDATA is not terminated'],
    ['an unterminated processing instruction', `<?xml version="1.0"${document('')}`, 'processing instruction'],
    ['a control character in a comment', document('<Metadata><!-- bad\u0000 --></Metadata>'), 'invalid XML character'],
    ['a control character in CDATA', document('<Metadata><![CDATA[bad\u0000]]></Metadata>'), 'invalid XML character'],
    ['a control character in a processing instruction', `<?bad \u0000?>${document('')}`, 'invalid XML character'],
  ])('rejects malformed XML: %s', (_label, xml, message) => {
    expect(() => parseVsixManifestIdentity(toBytes(xml), 'extension.vsixmanifest')).toThrow(message);
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(() => parseVsixManifestIdentity(new Uint8Array([0xff]), 'extension.vsixmanifest'))
      .toThrow('extension.vsixmanifest is not valid UTF-8 XML');
  });
});
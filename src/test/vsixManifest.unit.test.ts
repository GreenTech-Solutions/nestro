import { describe, expect, it } from 'vitest';
import { parseVsixManifestIdentity } from '../tools';
import { toBytes } from './fixtures';

const VSX_SCHEMA_URI = 'http://schemas.microsoft.com/developer/vsx-schema/2011';
const LABEL = 'extension.vsixmanifest';

const REAL_VSCE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
  <PackageManifest Version="2.0.0" xmlns="${VSX_SCHEMA_URI}" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
    <Metadata>
      <Identity Language="en-US" Id="nestro" Version="1.0.2" Publisher="greentech-solutions" />
      <DisplayName>Nestro</DisplayName>
      <Description xml:space="preserve">Manage npm/pnpm/yarn packages from the VS Code sidebar with update status and version switching</Description>
      <Tags>npm,pnpm,yarn,bun,packages,dependencies,update,manager,sidebar,audit,node</Tags>
      <Categories>Other</Categories>
      <GalleryFlags>Public</GalleryFlags>

      <Properties>
        <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.125.0" />
        <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
        <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
        <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/GreenTech-Solutions/nestro.git" />
        <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="#1e1e2e" />
        <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
      </Properties>
      <License>extension/LICENSE.txt</License>
      <Icon>extension/resources/icon.png</Icon>
    </Metadata>
    <Installation>
      <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
    </Installation>
    <Dependencies/>
    <Assets>
      <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
      <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    </Assets>
  </PackageManifest>`;

function manifest(identity: string): Uint8Array {
  return toBytes(
    `<?xml version="1.0"?><PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata>${identity}</Metadata></PackageManifest>`,
  );
}

function document(body: string): string {
  return `<PackageManifest xmlns="${VSX_SCHEMA_URI}">${body}</PackageManifest>`;
}

const VALID_IDENTITY = '<Identity Id="nestro" Version="9.9.9" Publisher="p" />';

describe('parseVsixManifestIdentity()', () => {
  it('reads the identity from a manifest produced by vsce', () => {
    expect(parseVsixManifestIdentity(toBytes(REAL_VSCE_MANIFEST), LABEL)).toEqual({
      id: 'nestro',
      version: '1.0.2',
      publisher: 'greentech-solutions',
    });
  });

  it('reads single- and double-quoted attributes in any order', () => {
    const bytes = manifest('<Identity Publisher="greentech-solutions" Version=\'9.9.9\' Id="nestro" />');

    expect(parseVsixManifestIdentity(bytes, LABEL)).toEqual({
      id: 'nestro',
      version: '9.9.9',
      publisher: 'greentech-solutions',
    });
  });

  it('does not treat Identity-looking comments or CDATA as elements', () => {
    const bytes = toBytes(`<?xml version="1.0"?>
      <PackageManifest xmlns="${VSX_SCHEMA_URI}">
        <Metadata>
          <!-- <Identity Id="comment" Version="1.0.0" Publisher="comment" /> -->
          <Description><![CDATA[<Identity Id="cdata" Version="1.0.0" Publisher="cdata" />]]></Description>
          <Identity Id="nestro" Version="9.9.9" Publisher="greentech-solutions" />
        </Metadata>
      </PackageManifest>`);

    expect(parseVsixManifestIdentity(bytes, LABEL).id).toBe('nestro');
  });

  it('accepts a BOM, an XML declaration, and processing instructions outside the root', () => {
    const bytes = toBytes(`﻿<?xml version='1.0' encoding="UTF-8" standalone='yes'?><?build data?>${document(
      `<Metadata>${VALID_IDENTITY}</Metadata>`,
    )}`);

    expect(parseVsixManifestIdentity(bytes, LABEL).id).toBe('nestro');
  });

  it('ignores prefixed attributes and unrelated namespace declarations on Identity', () => {
    const bytes = toBytes(`<PackageManifest xmlns="${VSX_SCHEMA_URI}" xmlns:a="urn:attributes">
      <Metadata><Identity a:Id="decoy" Id="nestro" Version="9.9.9" Publisher="p" /></Metadata>
    </PackageManifest>`);

    expect(parseVsixManifestIdentity(bytes, LABEL).id).toBe('nestro');
  });

  it.each([
    ['DOCTYPE declaration', `<!DOCTYPE PackageManifest>${document(`<Metadata>${VALID_IDENTITY}</Metadata>`)}`],
    [
      'DOCTYPE with an internal subset',
      `<!DOCTYPE PackageManifest [<!ENTITY x "y">]>${document(`<Metadata>${VALID_IDENTITY}</Metadata>`)}`,
    ],
    [
      'lowercase doctype',
      `<!doctype PackageManifest>${document(`<Metadata>${VALID_IDENTITY}</Metadata>`)}`,
    ],
    ['external entity declaration', `<!ENTITY xxe SYSTEM "file:///etc/passwd">${document('')}`],
    [
      'DOCTYPE hidden in a comment',
      document(`<Metadata><!-- <!DOCTYPE x> -->${VALID_IDENTITY}</Metadata>`),
    ],
  ])('rejects a %s before parsing', (_label, xml) => {
    expect(() => parseVsixManifestIdentity(toBytes(xml), LABEL))
      .toThrow('DOCTYPE and ENTITY declarations are not allowed');
  });

  it('rejects an entity-expansion document without expanding it', () => {
    const laughs = `<?xml version="1.0"?>
      <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
      ${document('<Metadata><Identity Id="&lol2;" Version="9.9.9" Publisher="p" /></Metadata>')}`;

    expect(() => parseVsixManifestIdentity(toBytes(laughs), LABEL)).toThrow('not allowed');
  });

  it.each(['amp', 'lt', 'quot', '#x74', '#116', 'lol'])(
    'rejects the entity reference &%s; in an identity attribute instead of decoding it',
    (entity) => {
      const bytes = manifest(`<Identity Id="nest&${entity};ro" Version="9.9.9" Publisher="p" />`);

      expect(() => parseVsixManifestIdentity(bytes, LABEL))
        .toThrow(new RegExp(`${LABEL}.*entity references`, 'u'));
    },
  );

  it.each([
    ['Id', '<Identity Id="' + 'a'.repeat(513) + '" Version="9.9.9" Publisher="p" />'],
    ['Version', '<Identity Id="nestro" Version="' + '1'.repeat(513) + '" Publisher="p" />'],
    ['Publisher', '<Identity Id="nestro" Version="9.9.9" Publisher="' + 'p'.repeat(513) + '" />'],
  ])('rejects an oversized %s attribute', (name, identity) => {
    expect(() => parseVsixManifestIdentity(manifest(identity), LABEL))
      .toThrow(`Identity ${name} exceeds 512 characters`);
  });

  it('accepts an identity attribute at the length limit', () => {
    const bytes = manifest(`<Identity Id="${'a'.repeat(512)}" Version="9.9.9" Publisher="p" />`);

    expect(parseVsixManifestIdentity(bytes, LABEL).id).toHaveLength(512);
  });

  it('rejects a document over the size limit', () => {
    const padding = `<!-- ${'x'.repeat(1024 * 1024)} -->`;
    const bytes = toBytes(document(`<Metadata>${padding}${VALID_IDENTITY}</Metadata>`));

    expect(() => parseVsixManifestIdentity(bytes, LABEL)).toThrow('document exceeds');
  });

  it.each([
    ['missing Identity', document('<Metadata />'), 'exactly one Identity'],
    ['missing Metadata', document(''), 'direct PackageManifest/Metadata child'],
    [
      'duplicate Identity',
      document('<Metadata><Identity Id="a" Version="1.0.0" Publisher="p" /><Identity Id="b" Version="1.0.0" Publisher="p" /></Metadata>'),
      'exactly one Identity',
    ],
    [
      'duplicate Metadata',
      document(`<Metadata>${VALID_IDENTITY}</Metadata><Metadata>${VALID_IDENTITY}</Metadata>`),
      'direct PackageManifest/Metadata child',
    ],
    [
      'missing required attribute',
      document('<Metadata><Identity Id="nestro" Version="9.9.9" /></Metadata>'),
      'Id, Version, and Publisher',
    ],
    [
      'empty required attribute',
      document('<Metadata><Identity Id="" Version="9.9.9" Publisher="p" /></Metadata>'),
      'Id, Version, and Publisher',
    ],
    [
      'duplicate attribute',
      document('<Metadata><Identity Id="nestro" Id="other" Version="9.9.9" Publisher="p" /></Metadata>'),
      'repeated',
    ],
    [
      'unquoted attribute',
      document('<Metadata><Identity Id=nestro Version="9.9.9" Publisher="p" /></Metadata>'),
      'not valid XML',
    ],
    [
      'mismatched closing element',
      document('<Metadata><Identity Id="nestro" Version="9.9.9" Publisher="p"></Metadata>'),
      'not valid XML',
    ],
    [
      'Identity at the wrong schema path',
      document(VALID_IDENTITY),
      'direct PackageManifest/Metadata child',
    ],
    [
      'a nested PackageManifest identity decoy',
      document(`<Wrapper><PackageManifest><Metadata>${VALID_IDENTITY}</Metadata></PackageManifest></Wrapper>`),
      'document root',
    ],
    [
      'a wrong root namespace',
      `<PackageManifest xmlns="urn:other"><Metadata>${VALID_IDENTITY}</Metadata></PackageManifest>`,
      'VSX schema namespace',
    ],
    [
      'a missing root namespace',
      `<PackageManifest><Metadata>${VALID_IDENTITY}</Metadata></PackageManifest>`,
      'VSX schema namespace',
    ],
    [
      'a prefixed root element',
      `<v:PackageManifest xmlns:v="${VSX_SCHEMA_URI}"><v:Metadata><v:Identity Id="nestro" Version="9.9.9" Publisher="p" /></v:Metadata></v:PackageManifest>`,
      'VSX schema namespace',
    ],
    [
      'a wrong root element',
      `<Other xmlns="${VSX_SCHEMA_URI}"><Metadata>${VALID_IDENTITY}</Metadata></Other>`,
      'root must be PackageManifest',
    ],
  ])('rejects %s with a label-aware diagnostic', (_label, xml, message) => {
    expect(() => parseVsixManifestIdentity(toBytes(xml), 'outer extension.vsixmanifest'))
      .toThrow(new RegExp(`outer extension\\.vsixmanifest.*${message}`, 'iu'));
  });

  it.each([
    ['an empty document', ''],
    ['text only', 'not xml'],
    ['an unclosed root', `<PackageManifest xmlns="${VSX_SCHEMA_URI}">`],
    ['an unterminated start element', `<PackageManifest xmlns="${VSX_SCHEMA_URI}"`],
    ['an invalid element name', '<1PackageManifest />'],
    ['an unterminated attribute quote', `<PackageManifest xmlns="${VSX_SCHEMA_URI}"><Metadata><Identity Id="nestro`],
    ['a second root', `${document(`<Metadata>${VALID_IDENTITY}</Metadata>`)}${document('')}`],
    ['junk before the root', `junk${document(`<Metadata>${VALID_IDENTITY}</Metadata>`)}`],
    ['an unterminated comment', document('<Metadata><!-- missing</Metadata>')],
    ['a reserved prototype element name', document('<Metadata><__proto__ /></Metadata>')],
    ['excessive element nesting', document(`<Metadata>${'<a>'.repeat(200)}${'</a>'.repeat(200)}</Metadata>`)],
  ])('rejects malformed XML: %s', (_label, xml) => {
    expect(() => parseVsixManifestIdentity(toBytes(xml), LABEL)).toThrow(`${LABEL} is not valid XML`);
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(() => parseVsixManifestIdentity(new Uint8Array([0xff]), LABEL))
      .toThrow('extension.vsixmanifest is not valid UTF-8 XML');
  });
});
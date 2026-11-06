// Unit tests for the SAML SP helper module (api/_lib/saml.js).
// Pure functions — real HMAC/crypto, real node-saml, no network. db.js is mocked
// so the cache provider never opens a real connection.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';
process.env.JWT_SECRET ||= 'test-saml-secret-at-least-32-characters';

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const saml = await import('../../api/_lib/saml.js');

const IDP_META = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/saml">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>MIIBfakeCERTbody==</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/slo"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso/redirect"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('parseIdpMetadata', () => {
	it('extracts entityID, redirect SSO URL, SLO URL, and signing cert', () => {
		const r = saml.parseIdpMetadata(IDP_META);
		expect(r.entityId).toBe('https://idp.example.com/saml');
		expect(r.ssoUrl).toBe('https://idp.example.com/sso/redirect'); // prefers HTTP-Redirect
		expect(r.sloUrl).toBe('https://idp.example.com/slo');
		expect(r.cert).toBe('MIIBfakeCERTbody=='); // PEM headers/whitespace stripped
	});

	it('returns null for non-metadata XML', () => {
		expect(saml.parseIdpMetadata('<foo/>')).toBeNull();
	});

	it('returns null when no signing cert is present', () => {
		const noCert = IDP_META.replace(/<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/, '');
		expect(saml.parseIdpMetadata(noCert)).toBeNull();
	});
});

describe('generateSpMetadataXml', () => {
	it('advertises our ACS URL and SP entity ID without needing IdP config', () => {
		const xml = saml.generateSpMetadataXml();
		expect(xml).toContain('https://three.ws/api/auth/saml/acs');
		expect(xml).toContain('https://three.ws/api/auth/saml/metadata');
	});
});

describe('RelayState sign/verify', () => {
	it('round-trips a payload', async () => {
		const rs = await saml.signRelayState({ next: '/settings', ts: 7 });
		expect(await saml.verifyRelayState(rs)).toEqual({ next: '/settings', ts: 7 });
	});

	it('rejects a tampered, malformed, or null RelayState', async () => {
		const rs = await saml.signRelayState({ next: '/x' });
		expect(await saml.verifyRelayState(rs.slice(0, -2) + 'zz')).toBeNull();
		expect(await saml.verifyRelayState('garbage')).toBeNull();
		expect(await saml.verifyRelayState(null)).toBeNull();
	});
});

describe('safeNextPath', () => {
	it('keeps same-origin relative paths', () => {
		expect(saml.safeNextPath('/dashboard')).toBe('/dashboard');
	});
	it('rejects open-redirect vectors', () => {
		expect(saml.safeNextPath('//evil.com')).toBe('/dashboard');
		expect(saml.safeNextPath('https://evil.com')).toBe('/dashboard');
		expect(saml.safeNextPath(undefined)).toBe('/dashboard');
		expect(saml.safeNextPath('x', '/home')).toBe('/home');
	});
});

describe('extractSamlIdentity', () => {
	it('reads a lowercased email attribute and a display name', () => {
		const id = saml.extractSamlIdentity({
			issuer: 'i',
			nameID: 'n',
			nameIDFormat: 'unspecified',
			email: 'Jane@Corp.COM',
			displayName: 'Jane Doe',
			sessionIndex: 'sx',
		});
		expect(id.email).toBe('jane@corp.com');
		expect(id.name).toBe('Jane Doe');
		expect(id.sessionIndex).toBe('sx');
	});

	it('falls back to an email-shaped NameID and given+surname', () => {
		const id = saml.extractSamlIdentity({
			issuer: 'i',
			nameID: 'bob@corp.com',
			nameIDFormat: 'persistent',
			givenName: 'Bob',
			sn: 'Smith',
		});
		expect(id.email).toBe('bob@corp.com');
		expect(id.name).toBe('Bob Smith');
	});

	it('leaves email null when the NameID is opaque', () => {
		const id = saml.extractSamlIdentity({ issuer: 'i', nameID: 'opaque-123', nameIDFormat: 'persistent' });
		expect(id.email).toBeNull();
	});

	it('reads OID and WS-Fed claim spellings', () => {
		const id = saml.extractSamlIdentity({
			issuer: 'i',
			nameID: 'n',
			nameIDFormat: 'unspecified',
			'urn:oid:0.9.2342.19200300.100.1.3': 'oid@corp.com',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Claim Name',
		});
		expect(id.email).toBe('oid@corp.com');
		expect(id.name).toBe('Claim Name');
	});
});

describe('samlConfigured / getSamlInstance', () => {
	beforeEach(() => {
		delete process.env.SAML_IDP_SSO_URL;
		delete process.env.SAML_IDP_CERT;
		delete process.env.SAML_IDP_METADATA_URL;
		delete process.env.SAML_IDP_ENTITY_ID;
	});

	it('is false and throws 501 when unconfigured', async () => {
		expect(saml.samlConfigured()).toBe(false);
		await expect(saml.getSamlInstance()).rejects.toMatchObject({ status: 501, code: 'not_configured' });
	});

	it('builds an instance from explicit IdP env fields', async () => {
		process.env.SAML_IDP_SSO_URL = 'https://idp.example.com/sso/redirect';
		process.env.SAML_IDP_CERT = 'MIIBfakeCERTbody==';
		process.env.SAML_IDP_ENTITY_ID = 'https://idp.example.com/saml';
		expect(saml.samlConfigured()).toBe(true);
		const inst = await saml.getSamlInstance();
		expect(typeof inst.getAuthorizeUrlAsync).toBe('function');
		expect(typeof inst.validatePostResponseAsync).toBe('function');
	});
});

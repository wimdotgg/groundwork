import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey, createVerify } from 'node:crypto';
import { GitHubError, createFixtureClient } from '../lib/github.mjs';
import { createAppJwt, mintInstallationToken, revokeInstallationToken } from './app-token.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const EXPIRES_AT = '2030-01-01T00:00:00Z';

/** Fixture client plus a record of request bodies, which onCall cannot see. */
function bodyRecordingClient(routes, options = {}) {
  const inner = createFixtureClient(routes, options);
  const bodies = [];
  const client = {
    ...inner,
    request(method, path, requestOptions) {
      bodies.push(requestOptions?.body ?? null);
      return inner.request(method, path, requestOptions);
    },
  };
  return { bodies, client };
}

/** makeClient seam recording which token got revoked and via which call. */
function revokeTracker() {
  const revocations = [];
  const makeClient = (token) => createFixtureClient(
    { 'DELETE /installation/token': { status: 204, data: '' } },
    { onCall: (record) => revocations.push({ token, ...record }) },
  );
  return { makeClient, revocations };
}

function decodeSegment(jwt, index) {
  return JSON.parse(Buffer.from(jwt.split('.')[index], 'base64url').toString('utf8'));
}

function verifyJwtSignature(jwt) {
  const [header, payload, signature] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(publicKey, signature, 'base64url');
}

function mintRoutes(granted) {
  return {
    'GET /orgs/acme/installation': { status: 200, data: { id: 7 } },
    'POST /app/installations/7/access_tokens': { status: 201, data: granted },
  };
}

test('createAppJwt: RS256 JWT with skewed iat, exp and client-id iss verifies against the public key', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  const seconds = Math.floor(now.getTime() / 1000);
  const jwt = createAppJwt({ clientId: 'Iv1.clientid', privateKey, now });
  assert.ok(verifyJwtSignature(jwt));
  assert.deepEqual(decodeSegment(jwt, 0), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodeSegment(jwt, 1), {
    iat: seconds - 60,
    exp: seconds + 540,
    iss: 'Iv1.clientid',
  });
});

test('createAppJwt: defaults now to the current time', () => {
  const before = Math.floor(Date.now() / 1000) - 60;
  const claims = decodeSegment(createAppJwt({ clientId: 'id', privateKey }), 1);
  const after = Math.floor(Date.now() / 1000) + 540;
  assert.ok(claims.iat >= before && claims.exp <= after);
  assert.equal(claims.iss, 'id');
});

test('createAppJwt: accepts a PKCS#1 RSA private key', () => {
  const pem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
  assert.match(pem, /^-----BEGIN RSA PRIVATE/);
  assert.equal(createAppJwt({ clientId: 'id', privateKey: pem }).split('.').length, 3);
});

test('createAppJwt: empty clientId throws GitHubError status 0 without key material', () => {
  assert.throws(() => createAppJwt({ clientId: '', privateKey }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 0);
    assert.match(e.message, /clientId/);
    assert.ok(!e.message.includes(privateKey));
    return true;
  });
});

test('createAppJwt: an unusable private key throws GitHubError status 0 without key material', () => {
  assert.throws(() => createAppJwt({ clientId: 'id', privateKey: 'not a key' }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 0);
    assert.ok(!e.message.includes('not a key'));
    return true;
  });
});

test('createAppJwt: accepts a KeyObject private key', () => {
  const jwt = createAppJwt({ clientId: 'id', privateKey: createPrivateKey(privateKey) });
  assert.ok(verifyJwtSignature(jwt));
});

test('createAppJwt: a non-RSA private key throws GitHubError status 0', () => {
  const ed25519 = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
  assert.throws(() => createAppJwt({ clientId: 'id', privateKey: ed25519 }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 0);
    assert.match(e.message, /RSA/);
    return true;
  });
});

test('createAppJwt: an invalid now throws GitHubError status 0', () => {
  for (const now of [new Date('not a date'), 1_700_000_000_000, '2026-03-01']) {
    assert.throws(() => createAppJwt({ clientId: 'id', privateKey, now }), (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 0);
      assert.match(e.message, /now/);
      return true;
    });
  }
});

test("mint: 'all' requests an installation-wide token without a repositories key", async () => {
  const { bodies, client } = bodyRecordingClient({
    'GET /orgs/acme/installation': { status: 200, data: { id: 4242 } },
    'POST /app/installations/4242/access_tokens': {
      status: 201,
      data: { token: 'tok-1', expires_at: EXPIRES_AT, permissions: { issues: 'write' }, repositories: [] },
    },
  });
  const result = await mintInstallationToken({
    client, org: 'acme', repositories: 'all', permissions: { issues: 'write' },
  });
  assert.deepEqual(bodies, [null, { permissions: { issues: 'write' } }]);
  assert.equal(result.token, 'tok-1');
  assert.equal(result.expiresAt.getTime(), Date.parse(EXPIRES_AT));
});

test('mint: restricts the token to the requested repository names', async () => {
  const { bodies, client } = bodyRecordingClient({
    'GET /orgs/acme/installation': { status: 200, data: { id: 7 } },
    'POST /app/installations/7/access_tokens': {
      status: 201,
      data: {
        token: 'tok-2',
        expires_at: EXPIRES_AT,
        permissions: { variables: 'read' },
        repositories: [{ id: 1, name: 'api' }, { id: 2, name: 'web' }],
      },
    },
  });
  await mintInstallationToken({
    client, org: 'acme', repositories: ['api', 'web'], permissions: { variables: 'read' },
  });
  assert.deepEqual(bodies[1], { permissions: { variables: 'read' }, repositories: ['api', 'web'] });
});

test('mint: installation 404 throws with the API status', async () => {
  const { client, bodies } = bodyRecordingClient({
    'GET /orgs/ghost/installation': { status: 404, data: { message: 'Not Found' } },
  });
  await assert.rejects(
    mintInstallationToken({ client, org: 'ghost', repositories: 'all', permissions: { issues: 'read' } }),
    (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 404);
      assert.equal(bodies.length, 1);
      return true;
    },
  );
});

test('mint: granted permissions narrower than requested revoke the token and throw', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'leaked-scope', expires_at: EXPIRES_AT, permissions: { issues: 'read' }, repositories: [],
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: 'all', permissions: { issues: 'write' }, makeClient,
    }),
    (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 0);
      assert.match(e.message, /permissions/);
      assert.ok(!e.message.includes('leaked-scope'));
      return true;
    },
  );
  assert.deepEqual(revocations.map(({ method, status }) => ({ method, status })),
    [{ method: 'DELETE', status: 204 }]);
  assert.equal(revocations[0].token, 'leaked-scope');
});

test('mint: granted repositories differing from requested revoke the token and throw', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-3', expires_at: EXPIRES_AT, permissions: { contents: 'read' },
    repositories: [{ id: 1, name: 'different-repo' }],
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: ['api'], permissions: { contents: 'read' }, makeClient,
    }),
    /repositories/,
  );
  assert.equal(revocations.length, 1);
});

test('mint: response missing token or expires_at revokes and throws', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({ permissions: { issues: 'read' } }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: 'all', permissions: { issues: 'read' }, makeClient,
    }),
    /token or expires_at/,
  );
  assert.equal(revocations.length, 0);
});

test('mint: invalid expires_at revokes the token it did receive and throws', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-bad-expiry', expires_at: 'not a date', permissions: { issues: 'read' },
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: 'all', permissions: { issues: 'read' }, makeClient,
    }),
    /token or expires_at/,
  );
  assert.deepEqual(revocations.map(({ token }) => token), ['tok-bad-expiry']);
});

test('mint: metadata read added by GitHub to a repository-scoped token is accepted', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-meta', expires_at: EXPIRES_AT,
    permissions: { issues: 'write', metadata: 'read' },
    repositories: [{ id: 1, name: 'api' }],
  }));
  const result = await mintInstallationToken({
    client, org: 'acme', repositories: ['api'], permissions: { issues: 'write' }, makeClient,
  });
  assert.equal(result.token, 'tok-meta');
  assert.equal(revocations.length, 0);
});

test('mint: any other extra permission or a different metadata level revokes and throws', async () => {
  const cases = [
    { issues: 'write', administration: 'write' },
    { issues: 'write', metadata: 'write' },
    { issues: 'write', metadata: 'read', checks: 'read' },
  ];
  for (const granted of cases) {
    const { makeClient, revocations } = revokeTracker();
    const { client } = bodyRecordingClient(mintRoutes({
      token: 'tok-broad', expires_at: EXPIRES_AT, permissions: granted,
    }));
    await assert.rejects(
      mintInstallationToken({
        client, org: 'acme', repositories: 'all', permissions: { issues: 'write' }, makeClient,
      }),
      /permissions differ/,
    );
    assert.equal(revocations.length, 1);
  }
});

test('mint: a requested metadata permission must be granted as requested', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-meta-missing', expires_at: EXPIRES_AT, permissions: { issues: 'read' },
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: 'all',
      permissions: { issues: 'read', metadata: 'read' }, makeClient,
    }),
    /permissions differ/,
  );
  assert.equal(revocations.length, 1);
});

test('mint: a broader permission grant revokes the token and throws', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-admin', expires_at: EXPIRES_AT,
    permissions: { issues: 'write', administration: 'write' },
    repositories: [{ id: 1, name: 'api' }],
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: ['api'], permissions: { issues: 'write' }, makeClient,
    }),
    (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 0);
      assert.match(e.message, /permissions differ/);
      assert.ok(!e.message.includes('tok-admin'));
      return true;
    },
  );
  assert.deepEqual(revocations.map(({ token }) => token), ['tok-admin']);
});

test('mint: a broader repository grant revokes the token and throws', async () => {
  const { makeClient, revocations } = revokeTracker();
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-wide', expires_at: EXPIRES_AT, permissions: { issues: 'write' },
    repositories: [{ id: 1, name: 'api' }, { id: 2, name: 'web' }],
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: ['api'], permissions: { issues: 'write' }, makeClient,
    }),
    /repositories differ/,
  );
  assert.deepEqual(revocations.map(({ token }) => token), ['tok-wide']);
});

test('mint: a failed revocation is named in the single error and keeps the mismatch', async () => {
  const makeClient = () => createFixtureClient({
    'DELETE /installation/token': { status: 500, data: { message: 'boom' } },
  });
  const { client } = bodyRecordingClient(mintRoutes({
    token: 'tok-stuck', expires_at: EXPIRES_AT, permissions: { issues: 'read' },
  }));
  await assert.rejects(
    mintInstallationToken({
      client, org: 'acme', repositories: 'all', permissions: { issues: 'write' }, makeClient,
    }),
    (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 0);
      assert.equal(e.message,
        'app-token: granted permissions differ from requested; revocation failed (status 500), token valid until expiry');
      assert.ok(!e.message.includes('tok-stuck'));
      return true;
    },
  );
});

test('mint: the default revoker builds its client from env and the minted token', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers });
    return new Response(null, { status: 204 });
  };
  try {
    const { client } = bodyRecordingClient(mintRoutes({
      token: 'tok-env', expires_at: EXPIRES_AT, permissions: { issues: 'read' },
    }));
    await assert.rejects(
      mintInstallationToken({
        client, org: 'acme', repositories: 'all', permissions: { issues: 'write' },
        env: { GITHUB_API_URL: 'https://ghe.example.test/api/v3' },
      }),
      /permissions differ/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ghe.example.test/api/v3/installation/token');
  assert.equal(requests[0].method, 'DELETE');
  assert.match(JSON.stringify(requests[0].headers), /tok-env/);
});

test('mint: invalid inputs throw before any call is made', async () => {
  const cases = [
    [{ org: '', repositories: 'all', permissions: { issues: 'read' } }, /org/],
    [{ org: 'acme', repositories: 'all', permissions: {} }, /permissions/],
    [{ org: 'acme', repositories: 'all', permissions: { issues: 'admin' } }, /issues/],
    [{ org: 'acme', permissions: { issues: 'read' } }, /repositories/],
    [{ org: 'acme', permissions: { issues: 'read' }, repositories: [] }, /repositories/],
    [{ org: 'acme', permissions: { issues: 'read' }, repositories: 'ALL' }, /repositories/],
    [{ org: 'acme', permissions: { issues: 'read' }, repositories: 'api' }, /repositories/],
    [{ org: 'acme', permissions: { issues: 'read' }, repositories: ['bad/name'] }, /repository names/],
  ];
  for (const [options, pattern] of cases) {
    let calls = 0;
    const client = createFixtureClient({}, { onCall: () => { calls += 1; } });
    await assert.rejects(mintInstallationToken({ client, ...options }), (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 0);
      assert.match(e.message, pattern);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test('revoke: DELETE /installation/token resolves on 204', async () => {
  const calls = [];
  const client = createFixtureClient(
    { 'DELETE /installation/token': { status: 204, data: '' } },
    { onCall: (record) => calls.push(record) },
  );
  await revokeInstallationToken(client);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/installation/token', status: 204 }]);
});

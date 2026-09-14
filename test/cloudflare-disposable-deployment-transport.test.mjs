import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN,
  CloudflareDisposableDeploymentTransportError,
  createCloudflareDisposableDeploymentTransport,
} from "../operations/cloudflare-disposable-deployment-transport.mjs";

const ACCOUNT_ID = "a".repeat(32);
const SCRIPT_NAME = "fixture-worker-01";
const WORKER_ID = "fixture-worker-immutable-id";
const WORKER_DOMAIN = `${SCRIPT_NAME}.fixture.workers.dev`;
const VECTORIZE_NAME = "fixture-index_path01";
const DATABASE_ID = "10000000-0000-4000-8000-000000000001";
const BASELINE_VERSION_ID = "20000000-0000-4000-8000-000000000002";
const VERSION_ID = "30000000-0000-4000-8000-000000000003";
const DEPLOYMENT_ID = "40000000-0000-4000-8000-000000000004";
const TOKEN = "fixture-token-never-print-123456789";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function envelope(result, resultInfo = undefined) {
  return {
    errors: [],
    messages: [],
    result,
    success: true,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function stalledJsonResponse() {
  return new Response(new ReadableStream({}), {
    headers: { "content-type": "application/json" },
  });
}

function failedJsonResponse(message) {
  return new Response(new ReadableStream({
    pull(controller) { controller.error(new Error(message)); },
  }), {
    headers: { "content-type": "application/json" },
  });
}

function excessivelyFragmentedJsonResponse() {
  let chunks = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      chunks += 1;
      if (chunks > 9_000) controller.close();
      else controller.enqueue(new Uint8Array());
    },
  }), {
    headers: { "content-type": "application/json" },
  });
}

function tokenResolver(records) {
  return () => {
    const token = Buffer.from(TOKEN, "utf8");
    records.push(token);
    return token;
  };
}

function uploadInput(overrides = {}) {
  return {
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    main_module: "worker/src/index.js",
    modules: [
      {
        name: "worker/src/lib/z.js",
        content_type: "application/javascript+module",
        bytes: Buffer.from("export const z = 1;\n"),
      },
      {
        name: "worker/src/index.js",
        content_type: "application/javascript+module",
        bytes: Buffer.from("import './lib/z.js'; export default { fetch() {} };\n"),
      },
    ],
    compatibility_date: "2026-01-01",
    bindings: [
      { name: "VECTORIZE", type: "vectorize", index_name: VECTORIZE_NAME },
      { name: "BRAIN_VERSION", type: "plain_text", text: "0.4.8" },
      { name: "DB", type: "d1", database_id: DATABASE_ID },
      { name: "AI", type: "ai" },
    ],
    secret_names: ["OAUTH_STATE_SECRET", "ADMIN_KEY"],
    baseline_version_id: BASELINE_VERSION_ID,
    tag: "v048-fixture-active",
    message: "Financial Brain 0.4.8 disposable recovery fixture active",
    ...overrides,
  };
}

function capturedFetch(responses, calls) {
  return async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: { ...options.headers },
      headersReference: options.headers,
      body: options.body === undefined ? null : Buffer.from(options.body),
      redirect: options.redirect,
      cache: options.cache,
    });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("missing fixture response");
    return response;
  };
}

function parseMultipart(call) {
  const contentType = call.headers["Content-Type"];
  const match = /^multipart\/form-data; boundary=(.+)$/u.exec(contentType);
  assert.ok(match);
  const boundary = match[1];
  const text = call.body.toString("utf8");
  const metadataHeader = 'Content-Disposition: form-data; name="metadata"\r\n' +
    "Content-Type: application/json\r\n\r\n";
  const start = text.indexOf(metadataHeader);
  assert.notEqual(start, -1);
  const valueStart = start + metadataHeader.length;
  const valueEnd = text.indexOf(`\r\n--${boundary}\r\n`, valueStart);
  assert.notEqual(valueEnd, -1);
  return { boundary, metadata: JSON.parse(text.slice(valueStart, valueEnd)), text };
}

function deployment(versionId = VERSION_ID) {
  return {
    id: DEPLOYMENT_ID,
    created_on: "2026-09-12T12:00:00.000Z",
    source: "api",
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: versionId }],
  };
}

function provisionVersion({
  id = VERSION_ID,
  number = 1,
  tag = "fixture-bootstrap-tag",
  message = "fixture maintenance bootstrap",
  moduleSource = "export default { fetch() {} };\n",
} = {}) {
  return {
    id,
    created_on: "2026-09-13T12:00:00.000Z",
    number,
    urls: [],
    annotations: {
      "workers/message": message,
      "workers/tag": tag,
      "workers/triggered_by": "upload",
    },
    bindings: [
      { name: "ADMIN_KEY", type: "secret_text" },
      { name: "AI", type: "ai" },
      { name: "DB", type: "d1", database_id: DATABASE_ID, id: DATABASE_ID },
    ],
    cache_options: { enabled: false, cross_version_cache: false },
    compatibility_date: "2026-01-01",
    compatibility_flags: [],
    containers: [],
    exports: { default: { type: "worker", state: "created", cache: { enabled: false } } },
    main_module: "field-bootstrap.mjs",
    modules: [{
      content_base64: Buffer.from(moduleSource, "utf8").toString("base64"),
      content_type: "application/javascript+module",
      name: "field-bootstrap.mjs",
    }],
    usage_model: "standard",
  };
}

function provisionWorker({
  id = "e".repeat(32),
  name = SCRIPT_NAME,
  tag = "v048-field-source-fixture",
} = {}) {
  return {
    id,
    created_on: "2026-09-13T12:00:00.000Z",
    name,
    subdomain: {
      enabled: true,
      previews_enabled: false,
      url: `https://${name}.fixture.workers.dev`,
    },
    tags: [tag],
  };
}

function readBindings({ withMode = true } = {}) {
  return [
    { name: "AI", type: "ai" },
    { name: "ADMIN_KEY", type: "secret_text" },
    { name: "BRAIN_VERSION", type: "plain_text", text: "0.4.8" },
    { name: "DB", type: "d1", database_id: DATABASE_ID, id: DATABASE_ID },
    { name: "OAUTH_STATE_SECRET", type: "secret_text" },
    ...(withMode
      ? [{ name: "VECTOR_DRAIN_MODE", type: "plain_text", text: "paused-for-upgrade" }]
      : []),
    { name: "VECTORIZE", type: "vectorize", index_name: VECTORIZE_NAME },
  ];
}

function versionResult(bindings = readBindings()) {
  return {
    resources: {
      bindings,
      script: {
        etag: "opaque-script-etag",
        handlers: ["scheduled", "fetch"],
        last_deployed_from: "api",
        named_handlers: [],
      },
      script_runtime: {
        compatibility_date: "2026-01-01",
        compatibility_flags: [],
        usage_model: "standard",
      },
    },
    id: VERSION_ID,
    metadata: { source: "api" },
    number: 3,
  };
}

function versionExpectation(bindings = readBindings()) {
  return {
    compatibility_date: "2026-01-01",
    handlers: ["fetch", "scheduled"],
    bindings,
    mode_binding_name: "VECTOR_DRAIN_MODE",
  };
}

test("version upload is deterministic, strict, inherited, and never deploys", async () => {
  const tokens = [];
  const calls = [];
  const responses = [
    jsonResponse(envelope({ id: VERSION_ID })),
    jsonResponse(envelope({ id: VERSION_ID })),
  ];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, calls),
    resolveToken: tokenResolver(tokens),
  });

  const first = await transport.uploadVersion(uploadInput());
  const second = await transport.uploadVersion(uploadInput());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body,
    "the same module inventory and metadata must create identical multipart bytes");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].cache, "no-store");
  const url = new URL(calls[0].url);
  assert.equal(url.origin, CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN);
  assert.equal(url.pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/versions`);
  assert.deepEqual([...url.searchParams], [["bindings_inherit", "strict"]]);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(Object.hasOwn(calls[0].headersReference, "Authorization"), false,
    "the mutable local header must be scrubbed once fetch settles");
  assert.equal(calls[0].body.includes(Buffer.from(TOKEN)), false);
  assert.equal(calls[0].url.includes(TOKEN), false);

  const parsed = parseMultipart(calls[0]);
  assert.deepEqual(parsed.metadata, {
    annotations: {
      "workers/message": uploadInput().message,
      "workers/tag": uploadInput().tag,
    },
    bindings: [
      { name: "ADMIN_KEY", type: "inherit", version_id: BASELINE_VERSION_ID },
      { name: "AI", type: "ai" },
      { name: "BRAIN_VERSION", text: "0.4.8", type: "plain_text" },
      { database_id: DATABASE_ID, name: "DB", type: "d1" },
      { name: "OAUTH_STATE_SECRET", type: "inherit", version_id: BASELINE_VERSION_ID },
      { index_name: VECTORIZE_NAME, name: "VECTORIZE", type: "vectorize" },
    ],
    compatibility_date: "2026-01-01",
    main_module: "worker/src/index.js",
    usage_model: "standard",
  });
  assert.ok(parsed.text.indexOf('name="worker/src/index.js"') <
    parsed.text.indexOf('name="worker/src/lib/z.js"'));
  assert.equal(parsed.text.includes("secret_text"), false);
  assert.equal(parsed.text.includes("deploy"), false);

  assert.equal(first.operation, "upload_version");
  assert.equal(first.version_id, VERSION_ID);
  assert.equal(first.deployed, false);
  assert.equal(first.request.body_sha256, digest(calls[0].body));
  assert.equal(first.request.module_count, 2);
  assert.match(first.request.module_inventory_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.content_type, "application/json; charset=utf-8");
  assert.match(first.response.body_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  assert.ok(tokens.every((token) => token.every((byte) => byte === 0)));
});

test("multipart upload preserves binary module bytes and exact part headers", async () => {
  const calls = [];
  const binary = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x0d, 0x0a, 0x2d, 0x2d, 0x7f]);
  const input = uploadInput();
  input.modules.push({
    name: "worker/src/fixture.bin",
    content_type: "application/octet-stream",
    bytes: binary,
  });
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([jsonResponse(envelope({ id: VERSION_ID }))], calls),
    resolveToken: () => Buffer.from(TOKEN),
  });

  await transport.uploadVersion(input);
  const { boundary } = parseMultipart(calls[0]);
  const header = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="worker/src/fixture.bin"; ' +
    'filename="worker/src/fixture.bin"\r\n' +
    "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  );
  const headerStart = calls[0].body.indexOf(header);
  assert.notEqual(headerStart, -1);
  const valueStart = headerStart + header.length;
  const valueEnd = calls[0].body.indexOf(Buffer.from(`\r\n--${boundary}`, "ascii"), valueStart);
  assert.notEqual(valueEnd, -1);
  assert.deepEqual(calls[0].body.subarray(valueStart, valueEnd), binary);
});

test("multipart upload rejects cumulative module bytes before token resolution or fetch", async () => {
  const mainBytes = Buffer.alloc(12 * 1024 * 1024, 0x61);
  const otherBytes = Buffer.alloc(9 * 1024 * 1024, 0x62);
  let fetchCalls = 0;
  let tokenCalls = 0;
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
    resolveToken: () => {
      tokenCalls += 1;
      return Buffer.from(TOKEN);
    },
  });
  await assert.rejects(transport.uploadVersion(uploadInput({
    modules: [
      {
        name: "worker/src/index.js",
        content_type: "application/javascript+module",
        bytes: mainBytes,
      },
      {
        name: "worker/src/other.js",
        content_type: "application/javascript+module",
        bytes: otherBytes,
      },
    ],
  })), /CF_DISPOSABLE_TRANSPORT_UPLOAD_OVERSIZED/);
  assert.equal(fetchCalls, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(mainBytes[0], 0x61, "caller-owned source bytes must not be wiped");
  assert.equal(otherBytes[0], 0x62, "caller-owned source bytes must not be wiped");
});

test("every operation rejects non-Cloudflare script names before token resolution or fetch", async () => {
  const invalidNames = [
    ".",
    "..",
    "%2e",
    "fixture/path",
    "fixture worker",
    "Fixture",
    "-fixture",
    "fixture.name",
    "a".repeat(256),
  ];
  const operations = [
    ["uploadVersion", (transport, scriptName) => transport.uploadVersion(
      uploadInput({ script_name: scriptName }))],
    ["readVersion", (transport, scriptName) => transport.readVersion({
      account_id: ACCOUNT_ID,
      script_name: scriptName,
      version_id: VERSION_ID,
      expected: versionExpectation(),
    })],
    ["deployVersion", (transport, scriptName) => transport.deployVersion({
      account_id: ACCOUNT_ID,
      script_name: scriptName,
      version_id: VERSION_ID,
    })],
    ["readCurrentDeployment", (transport, scriptName) =>
      transport.readCurrentDeployment({
        account_id: ACCOUNT_ID,
        script_name: scriptName,
      })],
    ["readDeployment", (transport, scriptName) => transport.readDeployment({
      account_id: ACCOUNT_ID,
      deployment_id: DEPLOYMENT_ID,
      script_name: scriptName,
    })],
    ["readResourceContract", (transport, scriptName) => transport.readResourceContract(
      resourceRequest({ script_name: scriptName }))],
  ];

  for (const [operationName, invoke] of operations) {
    for (const scriptName of invalidNames) {
      let fetchCalls = 0;
      let tokenCalls = 0;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("must not fetch");
        },
        resolveToken: () => {
          tokenCalls += 1;
          return Buffer.from(TOKEN);
        },
      });
      await assert.rejects(invoke(transport, scriptName), (error) => {
        assert.ok(error instanceof CloudflareDisposableDeploymentTransportError);
        assert.equal(error.code, "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
        return true;
      }, `${operationName} must refuse ${JSON.stringify(scriptName)}`);
      assert.equal(fetchCalls, 0);
      assert.equal(tokenCalls, 0);
    }
  }
});

test("resource read rejects non-Cloudflare Vectorize names before token resolution or fetch", async () => {
  const invalidNames = [
    ".",
    "..",
    "%2e",
    "fixture/index",
    "fixture index",
    "Fixture",
    "-fixture",
    "_fixture",
    "fixture-",
    "a".repeat(65),
  ];
  for (const name of invalidNames) {
    let fetchCalls = 0;
    let tokenCalls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
      resolveToken: () => {
        tokenCalls += 1;
        return Buffer.from(TOKEN);
      },
    });
    await assert.rejects(transport.readResourceContract(resourceRequest({
      vectorize: { name, dimensions: 768, metric: "cosine" },
    })), (error) => {
      assert.ok(error instanceof CloudflareDisposableDeploymentTransportError);
      assert.equal(error.code, "CF_DISPOSABLE_TRANSPORT_TARGET_INVALID");
      return true;
    });
    assert.equal(fetchCalls, 0);
    assert.equal(tokenCalls, 0);
  }
});

test("upload rejects a non-Cloudflare Vectorize binding name before token resolution or fetch", async () => {
  let fetchCalls = 0;
  let tokenCalls = 0;
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
    resolveToken: () => {
      tokenCalls += 1;
      return Buffer.from(TOKEN);
    },
  });
  const input = uploadInput();
  input.bindings = input.bindings.map((binding) => binding.type === "vectorize"
    ? { ...binding, index_name: "../fixture-index" }
    : binding);
  await assert.rejects(transport.uploadVersion(input),
    /CF_DISPOSABLE_TRANSPORT_BINDING_INVALID/);
  assert.equal(fetchCalls, 0);
  assert.equal(tokenCalls, 0);
});

test("read version validates documented resources without returning binding values", async () => {
  const tokens = [];
  const calls = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([jsonResponse(envelope(versionResult()))], calls),
    resolveToken: tokenResolver(tokens),
  });
  const result = await transport.readVersion({
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    version_id: VERSION_ID,
    expected: versionExpectation(),
  });
  assert.equal(calls[0].method, "GET");
  assert.equal(new URL(calls[0].url).pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/versions/${VERSION_ID}`);
  assert.equal(result.version_id, VERSION_ID);
  assert.equal(result.script_etag, "opaque-script-etag");
  assert.deepEqual(result.handlers, ["fetch", "scheduled"]);
  assert.equal(result.bindings_exact, true);
  assert.equal(result.behavior_exact, true);
  assert.match(result.behavior_sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(result.bindings_sha256, result.bindings_without_mode_sha256);
  assert.equal(JSON.stringify(result).includes(DATABASE_ID), false);
  assert.equal(JSON.stringify(result).includes("paused-for-upgrade"), false);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("read version fails closed on mismatch and any returned secret value", async (t) => {
  await t.test("binding mismatch", async () => {
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => jsonResponse(envelope(versionResult(readBindings({ withMode: false })))),
      resolveToken: () => Buffer.from(TOKEN),
    });
    await assert.rejects(transport.readVersion({
      account_id: ACCOUNT_ID,
      script_name: "fixture",
      version_id: VERSION_ID,
      expected: versionExpectation(),
    }), /CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH/);
  });

  await t.test("secret value in response", async () => {
    const unsafe = readBindings().map((binding) => binding.name === "ADMIN_KEY"
      ? { ...binding, text: "provider-must-not-return-this" }
      : binding);
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => jsonResponse(envelope(versionResult(unsafe))),
      resolveToken: () => Buffer.from(TOKEN),
    });
    await assert.rejects(transport.readVersion({
      account_id: ACCOUNT_ID,
      script_name: "fixture",
      version_id: VERSION_ID,
      expected: versionExpectation(),
    }), /CF_DISPOSABLE_TRANSPORT_SECRET_RESPONSE_REFUSED/);
  });
});

test("deployment POST has one 100 percent version and never sends force", async () => {
  const tokens = [];
  const calls = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([jsonResponse(envelope(deployment()))], calls),
    resolveToken: tokenResolver(tokens),
  });
  const result = await transport.deployVersion({
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    version_id: VERSION_ID,
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/deployments`);
  assert.equal(url.search, "");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body.toString("utf8")), {
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: VERSION_ID }],
  });
  assert.equal(calls[0].body.toString("utf8").includes("force"), false);
  assert.equal(result.accepted, true);
  assert.equal(result.deployment_id, DEPLOYMENT_ID);
  assert.equal(result.version_id, VERSION_ID);
  assert.equal(result.percentage, 100);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("current deployment discovery returns only the documented first active deployment", async () => {
  const calls = [];
  const historicalDeploymentId = "50000000-0000-4000-8000-000000000005";
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([
      jsonResponse(envelope({
        deployments: [deployment(), {
          ...deployment(BASELINE_VERSION_ID),
          id: historicalDeploymentId,
        }],
      })),
    ], calls),
    resolveToken: () => Buffer.from(TOKEN),
  });
  const result = await transport.readCurrentDeployment({
    account_id: ACCOUNT_ID,
    script_name: "fixture",
  });
  assert.deepEqual(result.versions, [{ percentage: 100, version_id: VERSION_ID }]);
  assert.equal(result.deployment_id, DEPLOYMENT_ID);
  assert.equal(JSON.stringify(result).includes(historicalDeploymentId), false);
  assert.equal(calls[0].method, "GET");
});

test("deployment readback uses the exact deployment-id endpoint and binds its id", async () => {
  const calls = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([jsonResponse(envelope(deployment()))], calls),
    resolveToken: () => Buffer.from(TOKEN),
  });
  const result = await transport.readDeployment({
    account_id: ACCOUNT_ID,
    deployment_id: DEPLOYMENT_ID,
    script_name: SCRIPT_NAME,
  });
  assert.equal(result.deployment_id, DEPLOYMENT_ID);
  assert.deepEqual(result.versions, [{ percentage: 100, version_id: VERSION_ID }]);
  assert.equal(new URL(calls[0].url).pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/deployments/${DEPLOYMENT_ID}`);
  assert.equal(calls[0].method, "GET");

  const mismatch = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => jsonResponse(envelope({
      ...deployment(),
      id: "50000000-0000-4000-8000-000000000005",
    })),
    resolveToken: () => Buffer.from(TOKEN),
  });
  await assert.rejects(mismatch.readDeployment({
    account_id: ACCOUNT_ID,
    deployment_id: DEPLOYMENT_ID,
    script_name: SCRIPT_NAME,
  }), /CF_DISPOSABLE_TRANSPORT_DEPLOYMENT_MISMATCH/);
});

function resourceRequest(overrides = {}) {
  return {
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    database: { id: DATABASE_ID, name: "fixture-db" },
    vectorize: { name: VECTORIZE_NAME, dimensions: 768, metric: "cosine" },
    expected: {
      workers_dev_enabled: true,
      previews_enabled: false,
      routes_count: 0,
      custom_domains_count: 0,
      domain: WORKER_DOMAIN,
      schedules: [],
    },
    ...overrides,
  };
}

function resourceResponses({
  vectorDimensions = 768,
  workersDevEnabled = true,
  domainResultInfo = {
    count: 0,
    page: 1,
    per_page: 20,
    total_count: 2,
    total_pages: 0,
  },
} = {}) {
  return [
    jsonResponse(envelope([{
      id: SCRIPT_NAME,
      routes: [],
      created_on: "2026-09-12T11:00:00.000Z",
      modified_on: "2026-09-12T12:00:00.000Z",
      etag: digest("classic-worker-etag"),
      cache_options: { enabled: false },
      tail_consumers: [],
      has_assets: false,
      logpush: false,
      named_handlers: [],
      exports: { default: { type: "worker", cache: { enabled: false } } },
    }])),
    jsonResponse(envelope([{
      id: WORKER_ID,
      name: SCRIPT_NAME,
      deployed_on: "2026-09-12T12:00:00.000Z",
      created_on: "2026-09-12T11:00:00.000Z",
      updated_on: "2026-09-12T12:00:00.000Z",
    }], {
      count: 1,
      page: 1,
      per_page: 100,
      total_count: 1,
      total_pages: 1,
    })),
    jsonResponse(envelope({
      id: WORKER_ID,
      name: SCRIPT_NAME,
      references: {
        dispatch_namespace_outbounds: [],
        domains: [],
        durable_objects: [],
        queues: [],
        workers: [],
      },
      subdomain: {
        enabled: true,
        previews_enabled: false,
        url: `https://${WORKER_DOMAIN}`,
        preview_url_suffix: `-${WORKER_DOMAIN}`,
      },
      tail_consumers: [],
    })),
    jsonResponse(envelope({ enabled: workersDevEnabled, previews_enabled: false })),
    jsonResponse(envelope({ schedules: [] })),
    jsonResponse(envelope([], domainResultInfo)),
    jsonResponse(envelope({ name: "fixture-db", uuid: DATABASE_ID })),
    jsonResponse(envelope({
      config: { dimensions: vectorDimensions, metric: "cosine" },
      name: VECTORIZE_NAME,
    })),
    jsonResponse(envelope({ dimensions: vectorDimensions, vectorCount: 0 })),
  ];
}

test("resource contract reads exact Worker, routes, domains, D1, and Vectorize resources", async () => {
  const calls = [];
  const tokens = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(resourceResponses(), calls),
    resolveToken: tokenResolver(tokens),
  });
  const result = await transport.readResourceContract(resourceRequest());
  assert.deepEqual(calls.map((call) => call.method), Array(9).fill("GET"));
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/workers`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/workers/${WORKER_ID}`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/subdomain`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/domains`,
    `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`,
    `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_NAME}`,
    `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_NAME}/info`,
  ]);
  assert.deepEqual([...new URL(calls[5].url).searchParams],
    [["service", SCRIPT_NAME]]);
  assert.deepEqual([...new URL(calls[6].url).searchParams], [["fields", "uuid,name"]]);
  assert.equal(result.worker_exists, true);
  assert.equal(result.d1_name_and_id_exact, true);
  assert.equal(result.vectorize_name_exact, true);
  assert.equal(result.vector_dimensions, 768);
  assert.equal(result.vector_metric, "cosine");
  assert.equal(result.vector_count, 0);
  assert.equal(result.routes_count, 0);
  assert.equal(result.custom_domains_count, 0);
  assert.equal(result.schedules_count, 0);
  assert.equal(result.responses.length, 9);
  assert.deepEqual(result.responses.map((entry) => entry.operation), [
    "list_workers",
    "list_beta_workers_page_1",
    "read_beta_worker",
    "read_worker_subdomain",
    "read_worker_schedules",
    "list_worker_domains",
    "read_d1_database",
    "read_vectorize_index",
    "read_vectorize_info",
  ]);
  assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
  assert.equal(JSON.stringify(result).includes(DATABASE_ID), false);
  assert.equal(JSON.stringify(result).includes(SCRIPT_NAME), false);
  assert.equal(result.network_isolation.worker_identity_proved, true);
  assert.match(result.network_isolation.worker_identity_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(tokens.length, 1, "one bounded read set uses one short-lived token");
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("resource contract accepts Cloudflare's deprecated custom-domain environment as optional", async () => {
  const responses = resourceResponses();
  responses[5] = jsonResponse(envelope([{
    id: "domain-fixture-id",
    cert_id: "certificate-fixture-id",
    hostname: "brain-fixture.example.com",
    service: SCRIPT_NAME,
    zone_id: "zone-fixture-id",
    zone_name: "example.com",
  }]));
  const input = resourceRequest();
  input.expected = { ...input.expected, custom_domains_count: 1 };
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, []),
    resolveToken: () => Buffer.from(TOKEN),
  });
  const result = await transport.readResourceContract(input);
  assert.equal(result.custom_domains_count, 1);
});

test("resource contract refuses a custom domain returned for a different service", async () => {
  const responses = resourceResponses();
  responses[5] = jsonResponse(envelope([{
    id: "domain-fixture-id",
    cert_id: "certificate-fixture-id",
    hostname: "brain-fixture.example.com",
    service: "different-worker-service",
    zone_id: "zone-fixture-id",
    zone_name: "example.com",
  }]));
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, []),
    resolveToken: () => Buffer.from(TOKEN),
  });
  await assert.rejects(
    transport.readResourceContract(resourceRequest()),
    /CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID/u,
  );
});

test("resource contract treats SinglePage custom-domain totals as informational", async () => {
  for (const domainResultInfo of [
    { count: 0, page: 1, per_page: 20, total_count: 2, total_pages: 0 },
    { count: 0, page: 1, per_page: 100, total_count: 101, total_pages: 2 },
  ]) {
    const calls = [];
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: capturedFetch(resourceResponses({ domainResultInfo }), calls),
      resolveToken: () => Buffer.from(TOKEN),
    });
    const result = await transport.readResourceContract(resourceRequest());
    assert.equal(result.custom_domains_count, 0);
    assert.equal(calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/workers/domains")).length, 1);
  }
});

test("resource contract refuses invalid filtered custom-domain result metadata", async () => {
  for (const domainResultInfo of [
    { count: 1, page: 1, per_page: 20, total_count: 2, total_pages: 0 },
    { count: 0, page: 2, per_page: 20, total_count: 2, total_pages: 0 },
    { count: 0, page: 1, per_page: 0, total_count: 2, total_pages: 0 },
  ]) {
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: capturedFetch(resourceResponses({ domainResultInfo }), []),
      resolveToken: () => Buffer.from(TOKEN),
    });
    await assert.rejects(
      transport.readResourceContract(resourceRequest()),
      /CF_DISPOSABLE_TRANSPORT_RESOURCE_RESPONSE_INVALID/u,
    );
  }
});

test("resource contract refuses provider mismatch after complete readback", async () => {
  const calls = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(resourceResponses({ vectorDimensions: 1024 }), calls),
    resolveToken: () => Buffer.from(TOKEN),
  });
  await assert.rejects(transport.readResourceContract(resourceRequest()),
    /CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH/);
  assert.equal(calls.length, 8,
    "the exact index mismatch stops before treating its info endpoint as useful proof");
});

test("redirect, oversized, malformed, and unsuccessful envelopes fail closed", async (t) => {
  const cases = [
    {
      name: "redirect",
      response: jsonResponse(envelope({ deployments: [deployment()] }), { status: 302 }),
      code: "CF_DISPOSABLE_TRANSPORT_REDIRECT_REFUSED",
    },
    {
      name: "oversized",
      response: jsonResponse(envelope({ deployments: [deployment()], padding: "x".repeat(2048) })),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_OVERSIZED",
      maximumResponseBytes: 64,
    },
    {
      name: "malformed json",
      response: new Response("{", { headers: { "content-type": "application/json" } }),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
    {
      name: "excessive response fragmentation",
      response: excessivelyFragmentedJsonResponse(),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
    {
      name: "invalid utf8",
      response: new Response(Uint8Array.from([0xc3, 0x28]), {
        headers: { "content-type": "application/json" },
      }),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
    {
      name: "wrong media type",
      response: new Response(JSON.stringify(envelope({ deployments: [deployment()] })), {
        headers: { "content-type": "text/plain" },
      }),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
    {
      name: "unexpected json parameter",
      response: new Response(JSON.stringify(envelope({ deployments: [deployment()] })), {
        headers: { "content-type": "application/json; profile=provider" },
      }),
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
    {
      name: "provider error envelope",
      response: jsonResponse({
        errors: [{ code: 1000, message: "raw-provider-secret-message" }],
        messages: [],
        result: null,
        success: false,
      }, { status: 403 }),
      code: "CF_DISPOSABLE_TRANSPORT_API_REFUSED",
    },
    {
      name: "unexpected envelope member",
      response: jsonResponse({ ...envelope({ deployments: [deployment()] }), extra: true }),
      code: "CF_DISPOSABLE_TRANSPORT_API_REFUSED",
    },
    {
      name: "provider response accessor throws sensitive detail",
      response: {
        status: 200,
        headers: {
          get() { throw new Error(`raw-provider-secret-message ${TOKEN}`); },
        },
        body: new ReadableStream({}),
      },
      code: "CF_DISPOSABLE_TRANSPORT_RESPONSE_INVALID",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const tokenRecords = [];
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: async () => item.response,
        resolveToken: tokenResolver(tokenRecords),
        ...(item.maximumResponseBytes
          ? { maximumResponseBytes: item.maximumResponseBytes }
          : {}),
      });
      let seen;
      try {
        await transport.readDeployment({
          account_id: ACCOUNT_ID,
          deployment_id: DEPLOYMENT_ID,
          script_name: "fixture",
        });
      } catch (error) {
        seen = error;
      }
      assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
      assert.equal(seen.code, item.code);
      assert.equal(seen.message, item.code);
      assert.equal(String(seen).includes("raw-provider-secret-message"), false);
      assert.ok(tokenRecords[0].every((byte) => byte === 0));
    });
  }
});

test("request timeout remains active until the complete bounded response body is read", {
  timeout: 1_000,
}, async () => {
  const tokens = [];
  let calls = 0;
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => {
      calls += 1;
      return stalledJsonResponse();
    },
    resolveToken: tokenResolver(tokens),
    requestTimeoutMs: 10,
  });
  const startedAt = Date.now();
  let seen;
  try {
    await transport.readDeployment({
      account_id: ACCOUNT_ID,
      deployment_id: DEPLOYMENT_ID,
      script_name: SCRIPT_NAME,
    });
  } catch (error) {
    seen = error;
  }
  assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
  assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_REQUEST_TIMEOUT");
  assert.ok(Date.now() - startedAt < 500, "the stalled body must not outlive its deadline");
  assert.equal(calls, 1);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("a GET response cannot reflect the bearer token", async () => {
  const token = Buffer.from(TOKEN);
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => jsonResponse(envelope({
      deployments: [{ ...deployment(), source: TOKEN }],
    })),
    resolveToken: () => token,
  });
  await assert.rejects(transport.readDeployment({
    account_id: ACCOUNT_ID,
    deployment_id: DEPLOYMENT_ID,
    script_name: SCRIPT_NAME,
  }), /CF_DISPOSABLE_TRANSPORT_TOKEN_RESPONSE_REFUSED/);
  assert.ok(token.every((byte) => byte === 0));
});

test("response token scan checks decoded JSON strings rather than their escaped serialization", async () => {
  const escapedToken = 'fixture-"quoted\\token"-123456789';
  const token = Buffer.from(escapedToken, "utf8");
  const reflected = versionResult();
  reflected.resources.script.etag = escapedToken;
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => jsonResponse(envelope(reflected)),
    resolveToken: () => token,
  });
  let seen;
  try {
    await transport.readVersion({
      account_id: ACCOUNT_ID,
      script_name: SCRIPT_NAME,
      version_id: VERSION_ID,
      expected: versionExpectation(),
    });
  } catch (error) {
    seen = error;
  }
  assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
  assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_TOKEN_RESPONSE_REFUSED");
  assert.equal(String(seen).includes(escapedToken), false);
  assert.ok(token.every((byte) => byte === 0));
});

test("a mutation response that reflects the bearer token is only reported as ambiguous", async () => {
  const token = Buffer.from(TOKEN);
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => jsonResponse(envelope({
      ...deployment(),
      source: TOKEN,
    })),
    resolveToken: () => token,
  });
  let seen;
  try {
    await transport.deployVersion({
      account_id: ACCOUNT_ID,
      script_name: SCRIPT_NAME,
      version_id: VERSION_ID,
    });
  } catch (error) {
    seen = error;
  }
  assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
  assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
  assert.equal(String(seen).includes(TOKEN), false);
  assert.ok(token.every((byte) => byte === 0));
});

test("every uncertain post-POST outcome is ambiguous, is not retried, and leaks no detail", async (t) => {
  await t.test("version upload", async () => {
    const tokens = [];
    let calls = 0;
    let headers;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async (_url, options) => {
        calls += 1;
        headers = options.headers;
        throw new Error(`socket ended after send ${TOKEN}`);
      },
      resolveToken: tokenResolver(tokens),
    });
    let seen;
    try { await transport.uploadVersion(uploadInput()); } catch (error) { seen = error; }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(headers, "Authorization"), false);
    assert.equal(String(seen).includes(TOKEN), false);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("deployment", async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("unknown commit status");
      },
      resolveToken: tokenResolver(tokens),
    });
    await assert.rejects(transport.deployVersion({
      account_id: ACCOUNT_ID,
      script_name: "fixture",
      version_id: VERSION_ID,
    }), /CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS/);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("malformed JSON after version upload", async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        return new Response("{", { headers: { "content-type": "application/json" } });
      },
      resolveToken: tokenResolver(tokens),
    });
    let seen;
    try { await transport.uploadVersion(uploadInput()); } catch (error) { seen = error; }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(String(seen).includes("RESPONSE_INVALID"), false);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("response stream failure after deployment", async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        return failedJsonResponse(`provider stream detail ${TOKEN}`);
      },
      resolveToken: tokenResolver(tokens),
    });
    let seen;
    try {
      await transport.deployVersion({
        account_id: ACCOUNT_ID,
        script_name: SCRIPT_NAME,
        version_id: VERSION_ID,
      });
    } catch (error) {
      seen = error;
    }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(String(seen).includes(TOKEN), false);
    assert.equal(String(seen).includes("provider stream detail"), false);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("invalid successful version-upload result", async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(envelope({ id: "not-a-version-id" }));
      },
      resolveToken: tokenResolver(tokens),
    });
    let seen;
    try { await transport.uploadVersion(uploadInput()); } catch (error) { seen = error; }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(String(seen).includes("UPLOAD_RESPONSE_INVALID"), false);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("successful deployment result names a different version", async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(envelope(deployment(BASELINE_VERSION_ID)));
      },
      resolveToken: tokenResolver(tokens),
    });
    let seen;
    try {
      await transport.deployVersion({
        account_id: ACCOUNT_ID,
        script_name: SCRIPT_NAME,
        version_id: VERSION_ID,
      });
    } catch (error) {
      seen = error;
    }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(String(seen).includes("DEPLOYMENT_MISMATCH"), false);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });

  await t.test("stalled response body after deployment", { timeout: 1_000 }, async () => {
    const tokens = [];
    let calls = 0;
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: async () => {
        calls += 1;
        return stalledJsonResponse();
      },
      resolveToken: tokenResolver(tokens),
      requestTimeoutMs: 10,
    });
    let seen;
    try {
      await transport.deployVersion({
        account_id: ACCOUNT_ID,
        script_name: SCRIPT_NAME,
        version_id: VERSION_ID,
      });
    } catch (error) {
      seen = error;
    }
    assert.ok(seen instanceof CloudflareDisposableDeploymentTransportError);
    assert.equal(seen.code, "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
    assert.equal(String(seen).includes("REQUEST_TIMEOUT"), false);
    assert.equal(calls, 1);
    assert.ok(tokens[0].every((byte) => byte === 0));
  });
});

test("token material is refused in a URL or request body before fetch", async () => {
  let calls = 0;
  const token = Buffer.from("0.4.8-fixture-token-value", "utf8");
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not run");
    },
    resolveToken: () => token,
  });
  await assert.rejects(transport.uploadVersion(uploadInput({
    bindings: [
      { name: "AI", type: "ai" },
      { name: "BRAIN_VERSION", type: "plain_text", text: "0.4.8-fixture-token-value" },
    ],
  })), /CF_DISPOSABLE_TRANSPORT_TOKEN_PLACEMENT_REFUSED/);
  assert.equal(calls, 0);
  assert.ok(token.every((byte) => byte === 0));
});

const CAMPAIGN = Object.freeze({
  source: Object.freeze({
    workerName: "campaign-source-worker",
    workerId: "campaign-source-worker-id",
    domain: "campaign-source-worker.fixture.workers.dev",
    databaseId: "50000000-0000-4000-8000-000000000005",
    databaseName: "campaign-source-db",
    vectorizeName: "campaign-source-index",
    versionId: "70000000-0000-4000-8000-000000000007",
    deploymentId: "90000000-0000-4000-8000-000000000009",
    deployedOn: "2026-09-12T13:00:00.000Z",
    scriptEtag: digest("campaign-source-script-etag"),
  }),
  target: Object.freeze({
    workerName: "campaign-target-worker",
    workerId: "campaign-target-worker-id",
    domain: "campaign-target-worker.fixture.workers.dev",
    databaseId: "60000000-0000-4000-8000-000000000006",
    databaseName: "campaign-target-db",
    vectorizeName: "campaign-target-index",
    versionId: "80000000-0000-4000-8000-000000000008",
    deploymentId: "a0000000-0000-4000-8000-00000000000a",
    deployedOn: "2026-09-12T13:05:00.000Z",
    scriptEtag: digest("campaign-target-script-etag"),
  }),
});

function campaignBindings(role) {
  const value = CAMPAIGN[role];
  return [
    { name: "AI", type: "ai", project: "<catalog>" },
    { name: "ADMIN_KEY", type: "secret_text" },
    {
      name: "ANSWER_MODEL",
      type: "plain_text",
      text: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    },
    { name: "BRAIN_NAME", type: "plain_text", text: `campaign-${role}` },
    { name: "BRAIN_OWNER", type: "plain_text", text: `Campaign ${role}` },
    { name: "BRAIN_VERSION", type: "plain_text", text: "0.4.8" },
    { name: "CHUNK_OVERLAP", type: "plain_text", text: "300" },
    { name: "CHUNK_SIZE", type: "plain_text", text: "1500" },
    { name: "CREDENTIAL_SCANNER", type: "plain_text", text: "on" },
    { name: "DAILY_LLM_CAP_USD", type: "plain_text", text: "10" },
    {
      name: "DB",
      type: "d1",
      database_id: value.databaseId,
      id: value.databaseId,
    },
    { name: "RAG_PROXY_KEY", type: "secret_text" },
    { name: "SESSION_SIGNING_KEY", type: "secret_text" },
    { name: "STORAGE", type: "plain_text", text: "d1" },
    {
      name: "VECTORIZE",
      type: "vectorize",
      index_name: value.vectorizeName,
    },
    ...(role === "target"
      ? [{ name: "BANK_FEED_WRAPPING_KEY_V2", type: "secret_text" }]
      : []),
  ];
}

function campaignVersion(role) {
  const value = CAMPAIGN[role];
  return {
    id: value.versionId,
    resources: {
      bindings: campaignBindings(role),
      script: {
        etag: value.scriptEtag,
        handlers: ["fetch", "scheduled"],
        last_deployed_from: "api",
        named_handlers: [],
      },
      script_runtime: {
        compatibility_date: "2026-01-01",
        usage_model: "standard",
      },
    },
  };
}

function campaignClassicWorker(role) {
  const value = CAMPAIGN[role];
  return {
    id: value.workerName,
    created_on: "2026-09-12T12:00:00.000Z",
    modified_on: value.deployedOn,
    etag: value.scriptEtag,
    cache_options: { enabled: false },
    tail_consumers: [],
    has_assets: false,
    logpush: false,
    named_handlers: [],
    exports: { default: { type: "worker", cache: { enabled: false } } },
  };
}

function campaignBetaWorker(role) {
  const value = CAMPAIGN[role];
  return {
    id: value.workerId,
    name: value.workerName,
    deployed_on: value.deployedOn,
  };
}

function campaignBetaDetail(role) {
  const value = CAMPAIGN[role];
  return {
    id: value.workerId,
    name: value.workerName,
    references: {
      dispatch_namespace_outbounds: [],
      domains: [],
      durable_objects: [],
      queues: [],
      workers: [],
    },
    subdomain: {
      enabled: true,
      previews_enabled: false,
      url: `https://${value.domain}`,
      preview_url_suffix: `-${value.domain}`,
    },
    tail_consumers: [],
  };
}

function campaignDeployment(role) {
  const value = CAMPAIGN[role];
  return {
    id: value.deploymentId,
    created_on: value.deployedOn,
    source: "api",
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: value.versionId }],
  };
}

function campaignRequest(teardownRole = "source") {
  const resource = (role) => ({
    worker_name: CAMPAIGN[role].workerName,
    d1_database_id: CAMPAIGN[role].databaseId,
    d1_database_name: CAMPAIGN[role].databaseName,
    vectorize_index_name: CAMPAIGN[role].vectorizeName,
    domain: CAMPAIGN[role].domain,
  });
  const expected = (role) => ({
    deployment_id: role === "target" ? null : CAMPAIGN[role].deploymentId,
    version_id: CAMPAIGN[role].versionId,
    script_etag: CAMPAIGN[role].scriptEtag,
    reviewed_worker_generation_sha256: null,
  });
  return {
    account_id: ACCOUNT_ID,
    teardown_role: teardownRole,
    campaign_resources: { source: resource("source"), target: resource("target") },
    expected_workers: { source: expected("source"), target: expected("target") },
  };
}

function campaignFetch({
  states = {
    source: { worker: "present", d1: "present", vectorize: "present" },
    target: { worker: "present", d1: "present", vectorize: "present" },
  },
  driftTargetVector = false,
} = {}) {
  const calls = [];
  let targetVectorReads = 0;
  const accountPrefix = `/client/v4/accounts/${ACCOUNT_ID}`;
  const absent = () => jsonResponse({
    errors: [{ code: 1000, message: "not found" }],
    messages: [],
    result: null,
    success: false,
  }, { status: 404 });
  const presentRoles = () => ["source", "target"].filter((role) =>
    states[role].worker === "present");
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const path = parsed.pathname.slice(accountPrefix.length);
    calls.push({ path, method: options.method, query: [...parsed.searchParams] });
    if (options.method !== "GET") throw new Error("unexpected campaign mutation");
    if (path === "/workers/workers") {
      const workers = presentRoles().map(campaignBetaWorker)
        .sort((left, right) => left.name.localeCompare(right.name));
      return jsonResponse(envelope(workers, {
        count: workers.length,
        page: 1,
        per_page: 100,
        total_count: workers.length,
        total_pages: workers.length === 0 ? 0 : 1,
      }));
    }
    if (path === "/workers/scripts") {
      return jsonResponse(envelope(presentRoles().map(campaignClassicWorker)));
    }
    for (const role of ["source", "target"]) {
      const value = CAMPAIGN[role];
      if (path === `/d1/database/${value.databaseId}`) {
        return states[role].d1 === "absent"
          ? absent()
          : jsonResponse(envelope({ name: value.databaseName, uuid: value.databaseId }));
      }
      if (path === `/vectorize/v2/indexes/${value.vectorizeName}`) {
        if (states[role].vectorize === "absent") return absent();
        if (role === "target") targetVectorReads += 1;
        return jsonResponse(envelope({
          config: { dimensions: 768, metric: "cosine" },
          created_on: driftTargetVector && role === "target"
            ? new Date(
              Date.parse(value.deployedOn) + targetVectorReads * 1000,
            ).toISOString()
            : value.deployedOn,
          name: value.vectorizeName,
        }));
      }
      if (path === `/workers/workers/${value.workerId}`) {
        return jsonResponse(envelope(campaignBetaDetail(role)));
      }
      if (path === `/workers/scripts/${value.workerName}/deployments`) {
        return jsonResponse(envelope({ deployments: [campaignDeployment(role)] }));
      }
      if (path === `/workers/scripts/${value.workerName}/versions/${value.versionId}`) {
        return jsonResponse(envelope(campaignVersion(role)));
      }
    }
    throw new Error(`unexpected fixture path ${path}`);
  };
  return { calls, fetchImpl };
}

test("campaign custody double-reads exact resources and returns a recomputable private authority", async () => {
  const tokens = [];
  const fixture = campaignFetch();
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: fixture.fetchImpl,
    resolveToken: tokenResolver(tokens),
  });
  const result = await transport.readCampaignCustody(campaignRequest());
  assert.equal(result.operation, "read_campaign_custody");
  assert.equal(result.captures, 2);
  assert.deepEqual(result.roles.source.state,
    { worker: "present", d1: "present", vectorize: "present" });
  assert.deepEqual(result.roles.target.state,
    { worker: "present", d1: "present", vectorize: "present" });
  assert.equal(result.roles.source.worker_protection.worker_generation_proved, true);
  assert.equal(result.roles.target.worker_protection.worker_generation_proved, true);
  assert.match(result.roles.target.worker_protection
    .reviewed_worker_generation_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.campaign_custody.account_workers, 2);
  assert.equal(result.campaign_custody.non_campaign_workers, 0);
  assert.equal(result.campaign_custody_authority.initial_worker_list.total_count, 2);
  assert.equal(result.generation_authority.source.version_id, CAMPAIGN.source.versionId);
  assert.equal(result.generation_authority.target.version_id, CAMPAIGN.target.versionId);
  assert.deepEqual(result.vectorize_instance_authority.target, {
    schema_version: 1,
    role: "target",
    index_name: CAMPAIGN.target.vectorizeName,
    dimensions: 768,
    metric: "cosine",
    created_on: CAMPAIGN.target.deployedOn,
    instance_sha256: result.roles.target.vectorize_instance_sha256,
  });
  assert.match(result.proof_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.responses.length, 30);
  assert.equal(fixture.calls.length, 30);
  assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
  assert.equal(JSON.stringify(result).includes(ACCOUNT_ID), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("campaign custody accepts ordered absent teardown states and nullable target deployment", async () => {
  const appFixture = campaignFetch({
    states: {
      source: { worker: "absent", d1: "present", vectorize: "present" },
      target: { worker: "present", d1: "present", vectorize: "present" },
    },
  });
  const appTransport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: appFixture.fetchImpl,
    resolveToken: () => Buffer.from(TOKEN),
  });
  const app = await appTransport.readCampaignCustody(campaignRequest("source"));
  assert.deepEqual(app.roles.source.state,
    { worker: "absent", d1: "present", vectorize: "present" });
  assert.equal(app.roles.source.worker_instance_sha256, null);
  assert.equal(app.roles.source.worker_protection, null);

  const targetFixture = campaignFetch({
    states: {
      source: { worker: "absent", d1: "absent", vectorize: "absent" },
      target: { worker: "present", d1: "present", vectorize: "present" },
    },
  });
  const targetTransport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: targetFixture.fetchImpl,
    resolveToken: () => Buffer.from(TOKEN),
  });
  const target = await targetTransport.readCampaignCustody(campaignRequest("target"));
  assert.deepEqual(target.roles.source.state,
    { worker: "absent", d1: "absent", vectorize: "absent" });
  assert.deepEqual(target.roles.target.state,
    { worker: "present", d1: "present", vectorize: "present" });
});

test("campaign custody refuses drift between independently complete captures", async () => {
  const fixture = campaignFetch({ driftTargetVector: true });
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: fixture.fetchImpl,
    resolveToken: () => Buffer.from(TOKEN),
  });
  await assert.rejects(
    transport.readCampaignCustody(campaignRequest()),
    /CF_DISPOSABLE_TRANSPORT_CAMPAIGN_CAPTURE_CHANGED/,
  );
  assert.equal(fixture.calls.length, 30);
});

test("general deployment transport exposes no teardown delete authority", () => {
  let providerCalls = 0;
  let tokenReads = 0;
  const transport = createCloudflareDisposableDeploymentTransport({
    async fetchImpl() {
      providerCalls += 1;
      throw new Error("provider must remain unreachable");
    },
    resolveToken() {
      tokenReads += 1;
      return Buffer.from(TOKEN);
    },
  });
  assert.equal(Object.isFrozen(transport), true);
  assert.equal(Object.hasOwn(transport, "deleteWorker"), false);
  assert.equal(Object.hasOwn(transport, "deleteVectorizeIndex"), false);
  assert.equal(Object.hasOwn(transport, "deleteD1Database"), false);
  assert.deepEqual(
    Object.keys(transport).filter((name) => /^delete/u.test(name)),
    [],
  );
  assert.equal(providerCalls, 0);
  assert.equal(tokenReads, 0);
});

test("provision collision scan exhausts Worker and D1 pages and sends no Vectorize query", async () => {
  const calls = [];
  const tokens = [];
  const workerPage = Array.from({ length: 100 }, (_, index) => ({
    id: index.toString(16).padStart(32, "0"),
    name: `unrelated-worker-${index}`,
  }));
  const matchingWorkerId = "f".repeat(32);
  const responses = [
    jsonResponse(envelope(workerPage, {
      count: 100, page: 1, per_page: 100, total_count: 101, total_pages: 2,
    })),
    jsonResponse(envelope([{ id: matchingWorkerId, name: SCRIPT_NAME }], {
      count: 1, page: 2, per_page: 100, total_count: 101, total_pages: 2,
    })),
    jsonResponse(envelope([], {
      count: 0, page: 1, per_page: 100, total_count: 0, total_pages: 1,
    })),
    jsonResponse(envelope([])),
  ];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, calls),
    resolveToken: tokenResolver(tokens),
  });
  const result = await transport.readProvisioningCollisions({
    account_id: ACCOUNT_ID,
    resource_name: SCRIPT_NAME,
  });
  assert.deepEqual(result.worker_ids, [matchingWorkerId]);
  assert.equal(result.worker_exists, true);
  assert.equal(result.d1_exists, false);
  assert.equal(result.vectorize_exists, false);
  assert.deepEqual(calls.map(({ url }) => {
    const parsed = new URL(url);
    return [parsed.pathname, [...parsed.searchParams]];
  }), [
    [`/client/v4/accounts/${ACCOUNT_ID}/workers/workers`, [
      ["order_by", "name"], ["order", "asc"], ["page", "1"], ["per_page", "100"],
    ]],
    [`/client/v4/accounts/${ACCOUNT_ID}/workers/workers`, [
      ["order_by", "name"], ["order", "asc"], ["page", "2"], ["per_page", "100"],
    ]],
    [`/client/v4/accounts/${ACCOUNT_ID}/d1/database`, [
      ["name", SCRIPT_NAME], ["page", "1"], ["per_page", "100"],
    ]],
    [`/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`, []],
  ]);
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("D1, Vectorize, and six metadata indexes use exact create and readback contracts", async () => {
  const calls = [];
  const tokens = [];
  const createdOn = "2026-09-13T12:00:00.000Z";
  const expectedIndexes = [
    ["source", "string"], ["client", "string"], ["category", "string"],
    ["top_folder", "string"], ["platform", "string"], ["document_date", "number"],
  ];
  const responses = [
    jsonResponse(envelope({
      uuid: DATABASE_ID, name: SCRIPT_NAME, created_at: createdOn,
    })),
    jsonResponse(envelope({
      name: SCRIPT_NAME, created_on: createdOn,
      config: { dimensions: 768, metric: "cosine" },
    })),
  ];
  const accumulated = [];
  for (const [propertyName, indexType] of expectedIndexes) {
    accumulated.push({ propertyName, indexType });
    responses.push(
      jsonResponse(envelope({ mutationId: `fixture-${propertyName}` })),
      jsonResponse(envelope({ metadataIndexes: accumulated.map((entry) => ({ ...entry })) })),
    );
  }
  responses.push(
    jsonResponse(envelope([], {
      count: 0, page: 1, per_page: 100, total_count: 0, total_pages: 1,
    })),
    jsonResponse(envelope([{ uuid: DATABASE_ID, name: SCRIPT_NAME }], {
      count: 1, page: 1, per_page: 100, total_count: 1, total_pages: 1,
    })),
    jsonResponse(envelope([{
      name: SCRIPT_NAME, created_on: createdOn,
      config: { dimensions: 768, metric: "cosine" },
    }])),
  );
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, calls),
    resolveToken: tokenResolver(tokens),
  });
  const d1 = await transport.createD1Database({
    account_id: ACCOUNT_ID,
    name: SCRIPT_NAME,
  });
  assert.equal(d1.database_id, DATABASE_ID);
  assert.equal(JSON.stringify(d1).includes(SCRIPT_NAME), false);
  const vector = await transport.createVectorizeIndex({
    account_id: ACCOUNT_ID,
    name: SCRIPT_NAME,
    dimensions: 768,
    metric: "cosine",
  });
  assert.equal(vector.accepted, true);
  assert.equal(vector.created_on, createdOn);
  for (const [propertyName, indexType] of expectedIndexes) {
    const created = await transport.createVectorizeMetadataIndex({
      account_id: ACCOUNT_ID,
      index_name: SCRIPT_NAME,
      property_name: propertyName,
      index_type: indexType,
    });
    assert.equal(created.accepted, true);
    const readback = await transport.readVectorizeMetadataIndexes({
      account_id: ACCOUNT_ID,
      index_name: SCRIPT_NAME,
    });
    assert.deepEqual(readback.indexes.find((entry) =>
      entry.property_name === propertyName), {
      property_name: propertyName,
      index_type: indexType,
    });
  }
  const inventory = await transport.readProvisioningCollisions({
    account_id: ACCOUNT_ID,
    resource_name: SCRIPT_NAME,
  });
  assert.deepEqual(inventory.d1_ids, [DATABASE_ID]);
  assert.deepEqual(inventory.vectorize_names, [SCRIPT_NAME]);
  assert.equal(inventory.vectorize_created_on, createdOn);

  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/d1/database`);
  assert.deepEqual(JSON.parse(calls[0].body.toString("utf8")), { name: SCRIPT_NAME });
  assert.equal(calls[1].method, "POST");
  assert.equal(new URL(calls[1].url).pathname,
    `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`);
  assert.deepEqual(JSON.parse(calls[1].body.toString("utf8")), {
    config: { dimensions: 768, metric: "cosine" }, name: SCRIPT_NAME,
  });
  for (const [index, [propertyName, indexType]] of expectedIndexes.entries()) {
    const createCall = calls[2 + index * 2];
    const readCall = calls[3 + index * 2];
    assert.equal(createCall.method, "POST");
    assert.equal(new URL(createCall.url).pathname,
      `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${SCRIPT_NAME}/metadata_index/create`);
    assert.deepEqual(JSON.parse(createCall.body.toString("utf8")), {
      indexType, propertyName,
    });
    assert.equal(readCall.method, "GET");
    assert.equal(new URL(readCall.url).pathname,
      `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${SCRIPT_NAME}/metadata_index/list`);
    assert.equal(readCall.body, null);
  }
  assert.equal(responses.length, 0);
  assert.equal(tokens.every((token) => token.every((byte) => byte === 0)), true);
});

test("every provisioning create treats malformed or lost POST outcomes as ambiguous once", async (t) => {
  const baselineInput = () => ({
    account_id: ACCOUNT_ID,
    worker_id: "e".repeat(32),
    main_module: "field-bootstrap.mjs",
    modules: [{
      name: "field-bootstrap.mjs",
      content_type: "application/javascript+module",
      bytes: Buffer.from("export default { fetch() {} };\n"),
    }],
    compatibility_date: "2026-01-01",
    bindings: [
      { name: "AI", type: "ai" },
      { name: "DB", type: "d1", database_id: DATABASE_ID },
    ],
    secret_bindings: [{ name: "ADMIN_KEY", text: "S".repeat(48) }],
    tag: "fixture-bootstrap-tag",
    message: "fixture maintenance bootstrap",
  });
  const operations = [
    ["d1", (transport) => transport.createD1Database({
      account_id: ACCOUNT_ID, name: SCRIPT_NAME,
    })],
    ["vectorize", (transport) => transport.createVectorizeIndex({
      account_id: ACCOUNT_ID, name: SCRIPT_NAME, dimensions: 768, metric: "cosine",
    })],
    ["metadata", (transport) => transport.createVectorizeMetadataIndex({
      account_id: ACCOUNT_ID, index_name: SCRIPT_NAME,
      property_name: "source", index_type: "string",
    })],
    ["worker-identity", (transport) => transport.createWorkerIdentity({
      account_id: ACCOUNT_ID,
      name: SCRIPT_NAME,
      tag: "v048-field-source-fixture",
    })],
    ["worker-baseline", (transport) => transport.createWorkerBaseline(baselineInput())],
  ];
  for (const [label, operation] of operations) {
    await t.test(`${label}:lost-response`, async () => {
      let calls = 0;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: async () => { calls += 1; throw new Error("synthetic lost response"); },
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(operation(transport), (error) =>
        error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
      assert.equal(calls, 1);
    });
    await t.test(`${label}:malformed-success`, async () => {
      let calls = 0;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(envelope({ unexpected: true }));
        },
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(operation(transport), (error) =>
        error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
      assert.equal(calls, 1);
    });
  }
});

test("D1 query uses the exact endpoint/body, sanitizes results, and never retries ambiguity", async (t) => {
  const sql = "SELECT ? AS value";
  const params = [7];
  await t.test("success", async () => {
    const calls = [];
    const tokens = [];
    const transport = createCloudflareDisposableDeploymentTransport({
      fetchImpl: capturedFetch([
        jsonResponse(envelope([{
          success: true,
          results: [{ value: 7 }],
          meta: { duration: 0.2, rows_read: 1, rows_written: 0 },
        }])),
      ], calls),
      resolveToken: tokenResolver(tokens),
    });
    const result = await transport.queryD1({
      account_id: ACCOUNT_ID,
      database_id: DATABASE_ID,
      sql,
      params,
    });
    assert.deepEqual(result.results, [{ value: 7 }]);
    assert.deepEqual(Object.keys(result).sort(), [
      "operation", "request_body_sha256", "response", "results", "schema_version",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(new URL(calls[0].url).pathname,
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
    assert.deepEqual(JSON.parse(calls[0].body.toString("utf8")), { params, sql });
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].every((byte) => byte === 0), true);
  });

  for (const [label, fetchImpl] of [
    ["lost-response", async () => { throw new Error("synthetic lost query response"); }],
    ["malformed-success", async () => jsonResponse(envelope([{ success: true }]))],
  ]) {
    await t.test(label, async () => {
      let calls = 0;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: async (...args) => {
          calls += 1;
          return fetchImpl(...args);
        },
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(transport.queryD1({
        account_id: ACCOUNT_ID,
        database_id: DATABASE_ID,
        sql,
        params,
      }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
      assert.equal(calls, 1);
    });
  }
});

test("Worker identity creation and exact-ID readback bind the campaign tag", async () => {
  const calls = [];
  const tokens = [];
  const workerId = "e".repeat(32);
  const tag = "v048-field-source-fixture";
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([
      jsonResponse(envelope(provisionWorker({ id: workerId, tag }))),
      jsonResponse(envelope(provisionWorker({ id: workerId, tag }))),
    ], calls),
    resolveToken: tokenResolver(tokens),
  });
  const created = await transport.createWorkerIdentity({
    account_id: ACCOUNT_ID,
    name: SCRIPT_NAME,
    tag,
  });
  assert.equal(created.worker_id, workerId);
  assert.equal(created.hostname, WORKER_DOMAIN);
  assert.equal(created.tag_sha256, digest(tag));
  assert.deepEqual(JSON.parse(calls[0].body.toString("utf8")), {
    name: SCRIPT_NAME,
    subdomain: { enabled: true, previews_enabled: false },
    tags: [tag],
  });
  const read = await transport.readWorkerIdentity({
    account_id: ACCOUNT_ID,
    worker_id: workerId,
    expected_name: SCRIPT_NAME,
    expected_tag: tag,
  });
  assert.equal(read.worker_id, workerId);
  assert.equal(read.hostname, WORKER_DOMAIN);
  assert.equal(read.tag_sha256, digest(tag));
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET"]);
  assert.equal(tokens.length, 2);
  assert.equal(tokens.every((token) => token.every((byte) => byte === 0)), true);

  const competing = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([
      jsonResponse(envelope(provisionWorker({ id: workerId, tag: "competing-writer" }))),
    ], []),
    resolveToken: tokenResolver([]),
  });
  await assert.rejects(competing.readWorkerIdentity({
    account_id: ACCOUNT_ID,
    worker_id: workerId,
    expected_name: SCRIPT_NAME,
    expected_tag: tag,
  }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
    error.code === "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
});

test("Worker identity readback accepts only its canonical expected workers.dev URL", async (t) => {
  const workerId = "e".repeat(32);
  const tag = "v048-field-source-fixture";
  const invalidUrls = [
    ["different Worker", "https://different-worker.fixture.workers.dev"],
    ["extra account label", `https://${SCRIPT_NAME}.extra.fixture.workers.dev`],
    ["empty userinfo", `https://@${WORKER_DOMAIN}`],
    ["username userinfo", `https://fixture-user@${WORKER_DOMAIN}`],
    ["explicit default port", `https://${WORKER_DOMAIN}:443`],
    ["nondefault port", `https://${WORKER_DOMAIN}:8443`],
    ["trailing slash", `https://${WORKER_DOMAIN}/`],
    ["path", `https://${WORKER_DOMAIN}/path`],
    ["query", `https://${WORKER_DOMAIN}?fixture=1`],
    ["fragment", `https://${WORKER_DOMAIN}#fixture`],
    ["non-HTTPS scheme", `http://${WORKER_DOMAIN}`],
    ["noncanonical case", `HTTPS://${WORKER_DOMAIN.toUpperCase()}`],
  ];
  for (const [name, url] of invalidUrls) {
    await t.test(name, async () => {
      const response = provisionWorker({ id: workerId, tag });
      response.subdomain.url = url;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: capturedFetch([jsonResponse(envelope(response))], []),
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(transport.readWorkerIdentity({
        account_id: ACCOUNT_ID,
        worker_id: workerId,
        expected_name: SCRIPT_NAME,
        expected_tag: tag,
      }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_PROVISION_RESPONSE_INVALID");
    });
  }
});

test("Worker identity creation treats a malformed workers.dev host as an ambiguous mutation", async () => {
  const calls = [];
  const workerId = "e".repeat(32);
  const tag = "v048-field-source-fixture";
  const response = provisionWorker({ id: workerId, tag });
  response.subdomain.url = `https://${SCRIPT_NAME}.extra.fixture.workers.dev`;
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([jsonResponse(envelope(response))], calls),
    resolveToken: tokenResolver([]),
  });
  await assert.rejects(transport.createWorkerIdentity({
    account_id: ACCOUNT_ID,
    name: SCRIPT_NAME,
    tag,
  }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
    error.code === "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("bootstrap upload keeps secret-derived hashes out of results and validates exact settings", async () => {
  const calls = [];
  const tokens = [];
  const workerId = "e".repeat(32);
  const adminSecret = "S".repeat(48);
  const settingsBindings = [
    { name: "ADMIN_KEY", type: "secret_text" },
    { name: "AI", type: "ai" },
    { name: "DB", type: "d1", database_id: DATABASE_ID, id: DATABASE_ID },
  ];
  const responses = [
    jsonResponse(envelope({ id: VERSION_ID })),
    jsonResponse(envelope({
      annotations: {
        "workers/message": "fixture maintenance bootstrap",
        "workers/tag": "fixture-bootstrap-tag",
      },
      bindings: settingsBindings,
      compatibility_date: "2026-01-01",
      compatibility_flags: [],
      cache_options: { enabled: false },
      main_module: "field-bootstrap.mjs",
      observability: { enabled: false },
      tags: ["fixture-worker-tag"],
      tail_consumers: [],
      usage_model: "standard",
    })),
    jsonResponse(envelope({ deployments: [] })),
  ];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, calls),
    resolveToken: tokenResolver(tokens),
  });
  const created = await transport.createWorkerBaseline({
    account_id: ACCOUNT_ID,
    worker_id: workerId,
    main_module: "field-bootstrap.mjs",
    modules: [{
      name: "field-bootstrap.mjs",
      content_type: "application/javascript+module",
      bytes: Buffer.from("export default { fetch() {} };\n"),
    }],
    compatibility_date: "2026-01-01",
    bindings: [
      { name: "AI", type: "ai" },
      { name: "DB", type: "d1", database_id: DATABASE_ID },
    ],
    secret_bindings: [{ name: "ADMIN_KEY", text: adminSecret }],
    tag: "fixture-bootstrap-tag",
    message: "fixture maintenance bootstrap",
  });
  assert.equal(created.version_id, VERSION_ID);
  assert.deepEqual(Object.keys(created.request).sort(), [
    "module_inventory_sha256", "redacted_semantic_sha256",
  ]);
  assert.equal(JSON.stringify(created).includes(adminSecret), false);
  assert.equal(Object.hasOwn(created.request, "body_sha256"), false);
  assert.equal(Object.hasOwn(created.request, "metadata_sha256"), false);
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual([
    new URL(calls[0].url).pathname,
    [...new URL(calls[0].url).searchParams],
  ], [
    `/client/v4/accounts/${ACCOUNT_ID}/workers/workers/${workerId}/versions`,
    [["deploy", "true"]],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body.toString("utf8")), {
    annotations: {
      "workers/message": "fixture maintenance bootstrap",
      "workers/tag": "fixture-bootstrap-tag",
    },
    bindings: [
      { name: "ADMIN_KEY", text: adminSecret, type: "secret_text" },
      { name: "AI", type: "ai" },
      { database_id: DATABASE_ID, name: "DB", type: "d1" },
    ],
    compatibility_date: "2026-01-01",
    main_module: "field-bootstrap.mjs",
    modules: [{
      content_base64: Buffer.from("export default { fetch() {} };\n").toString("base64"),
      content_type: "application/javascript+module",
      name: "field-bootstrap.mjs",
    }],
    usage_model: "standard",
  });
  assert.equal(calls[0].body.includes(Buffer.from(adminSecret)), true,
    "the provider request contains the secret binding only in transient request bytes");
  const settings = await transport.readWorkerVersionSettings({
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    main_module: "field-bootstrap.mjs",
    compatibility_date: "2026-01-01",
    bindings: settingsBindings,
    tag: "fixture-bootstrap-tag",
    message: "fixture maintenance bootstrap",
    worker_tag: "fixture-worker-tag",
  });
  assert.equal(settings.tag_sha256, digest("fixture-bootstrap-tag"));
  assert.equal(settings.behavior_exact, true);
  assert.match(settings.behavior_sha256, /^[a-f0-9]{64}$/u);
  const state = await transport.readCurrentDeploymentState({
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
  });
  assert.equal(state.deployment_count, 0);
  assert.equal(state.current, null);
  assert.equal(tokens.length, 3);
  assert.equal(tokens.every((token) => token.every((byte) => byte === 0)), true);
});

test("immutable-ID Worker version inventory exhausts pagination and exposes only hashed semantics", async () => {
  const calls = [];
  const tokens = [];
  const workerId = "e".repeat(32);
  const secondVersionId = "50000000-0000-4000-8000-000000000005";
  const responses = [
    jsonResponse(envelope([provisionVersion()], {
      count: 1, page: 1, per_page: 100, total_count: 2, total_pages: 2,
    })),
    jsonResponse(envelope([provisionVersion({ id: secondVersionId, number: 2 })], {
      count: 1, page: 2, per_page: 100, total_count: 2, total_pages: 2,
    })),
    jsonResponse(envelope(provisionVersion({ id: secondVersionId, number: 2 }))),
  ];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(responses, calls),
    resolveToken: tokenResolver(tokens),
  });
  const inventory = await transport.readWorkerVersionInventory({
    account_id: ACCOUNT_ID,
    worker_id: workerId,
  });
  assert.equal(inventory.worker_id, workerId);
  assert.equal(inventory.version_count, 2);
  assert.deepEqual(inventory.versions.map(({ version_id: id }) => id),
    [VERSION_ID, secondVersionId].sort());
  assert.deepEqual(Object.keys(inventory.versions[0]).sort(),
    ["created_on", "number", "version_id"]);
  assert.equal(JSON.stringify(inventory).includes("fixture-bootstrap-tag"), false);
  assert.equal(JSON.stringify(inventory).includes("fixture maintenance bootstrap"), false);
  const exact = await transport.readWorkerVersionForProvisioning({
    account_id: ACCOUNT_ID,
    worker_id: workerId,
    version_id: secondVersionId,
  });
  assert.equal(exact.version_id, secondVersionId);
  assert.equal(exact.main_module, "field-bootstrap.mjs");
  assert.match(exact.module_inventory_sha256, /^[a-f0-9]{64}$/u);
  assert.match(exact.bindings_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(exact).includes("fixture-bootstrap-tag"), false);
  assert.deepEqual(calls.map(({ url }) => {
    const parsed = new URL(url);
    return [parsed.pathname, [...parsed.searchParams]];
  }), [
    [`/client/v4/accounts/${ACCOUNT_ID}/workers/workers/${workerId}/versions`, [
      ["page", "1"], ["per_page", "100"],
    ]],
    [`/client/v4/accounts/${ACCOUNT_ID}/workers/workers/${workerId}/versions`, [
      ["page", "2"], ["per_page", "100"],
    ]],
    [`/client/v4/accounts/${ACCOUNT_ID}/workers/workers/${workerId}/versions/${secondVersionId}`, [
      ["include", "modules"],
    ]],
  ]);
  assert.equal(tokens.length, 2);
  assert.equal(tokens.every((token) => token.every((byte) => byte === 0)), true);
});

test("exact Worker version read refuses returned secret text", async () => {
  const leaked = provisionVersion();
  leaked.bindings[0].text = "provider-must-never-return-this";
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch([
      jsonResponse(envelope(leaked)),
    ], []),
    resolveToken: tokenResolver([]),
  });
  await assert.rejects(transport.readWorkerVersionForProvisioning({
    account_id: ACCOUNT_ID,
    worker_id: "e".repeat(32),
    version_id: VERSION_ID,
  }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
    error.code === "CF_DISPOSABLE_TRANSPORT_SECRET_RESPONSE_REFUSED");
});

test("exact Worker version read refuses every behavior-affecting optional drift", async (t) => {
  const drifts = [
    ["assets", { config: { html_handling: "auto-trailing-slash" } }],
    ["cache_options", { enabled: true }],
    ["compatibility_flags", ["nodejs_compat"]],
    ["containers", [{ class_name: "UnexpectedContainer" }]],
    ["exports", { UnexpectedEntrypoint: { type: "worker" } }],
    ["exports_reconciliation", { unexpected: true }],
    ["limits", { cpu_ms: 10 }],
    ["migration_tag", "unexpected-migration"],
    ["migrations", { new_classes: ["UnexpectedObject"] }],
    ["package_dependencies", [{ name: "unexpected", installed_version: "1.0.0",
      package_json_version: "1.0.0" }]],
    ["placement", { mode: "smart" }],
    ["source", "dashboard"],
  ];
  for (const [field, drift] of drifts) {
    await t.test(field, async () => {
      const value = provisionVersion();
      value[field] = drift;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: capturedFetch([jsonResponse(envelope(value))], []),
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(transport.readWorkerVersionForProvisioning({
        account_id: ACCOUNT_ID,
        worker_id: "e".repeat(32),
        version_id: VERSION_ID,
      }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_PROVISION_VERSION_INVALID");
    });
  }
});

test("classic version and script settings refuse every optional runtime drift", async (t) => {
  const runtimeDrifts = [
    ["compatibility_flags", ["nodejs_compat"]],
    ["exports", { UnexpectedEntrypoint: { type: "worker" } }],
    ["limits", { cpu_ms: 10 }],
    ["migration_tag", "unexpected-migration"],
  ];
  for (const [field, drift] of runtimeDrifts) {
    await t.test(`classic-${field}`, async () => {
      const value = versionResult();
      value.resources.script_runtime[field] = drift;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: capturedFetch([jsonResponse(envelope(value))], []),
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(transport.readVersion({
        account_id: ACCOUNT_ID,
        script_name: SCRIPT_NAME,
        version_id: VERSION_ID,
        expected: versionExpectation(),
      }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
    });
  }

  const baseSettings = () => ({
    annotations: {
      "workers/message": "fixture maintenance bootstrap",
      "workers/tag": "fixture-bootstrap-tag",
    },
    bindings: [
      { name: "ADMIN_KEY", type: "secret_text" },
      { name: "AI", type: "ai" },
      { name: "DB", type: "d1", database_id: DATABASE_ID, id: DATABASE_ID },
    ],
    compatibility_date: "2026-01-01",
    main_module: "field-bootstrap.mjs",
    usage_model: "standard",
  });
  const settingsInput = {
    account_id: ACCOUNT_ID,
    script_name: SCRIPT_NAME,
    main_module: "field-bootstrap.mjs",
    compatibility_date: "2026-01-01",
    bindings: baseSettings().bindings,
    tag: "fixture-bootstrap-tag",
    message: "fixture maintenance bootstrap",
    worker_tag: "fixture-worker-tag",
  };
  const settingsDrifts = [
    ["assets", { config: { html_handling: "auto-trailing-slash" } }],
    ["cache_options", { enabled: true }],
    ["capnp_schema", "unexpected.capnp"],
    ["compatibility_flags", ["nodejs_compat"]],
    ["keep_assets", true],
    ["limits", { cpu_ms: 10 }],
    ["logpush", true],
    ["migrations", { new_classes: ["UnexpectedObject"] }],
    ["observability", { enabled: true }],
    ["placement", { mode: "smart" }],
    ["tail_consumers", [{ service: "unexpected-tail" }]],
    ["tags", ["competing-worker-tag"]],
  ];
  for (const [field, drift] of settingsDrifts) {
    await t.test(`settings-${field}`, async () => {
      const value = baseSettings();
      value[field] = drift;
      const transport = createCloudflareDisposableDeploymentTransport({
        fetchImpl: capturedFetch([jsonResponse(envelope(value))], []),
        resolveToken: tokenResolver([]),
      });
      await assert.rejects(transport.readWorkerVersionSettings(settingsInput), (error) =>
        error instanceof CloudflareDisposableDeploymentTransportError &&
        error.code === "CF_DISPOSABLE_TRANSPORT_VERSION_MISMATCH");
    });
  }
});

test("uncertain provisioning POST is ambiguous and never retried", async () => {
  let calls = 0;
  const tokens = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("synthetic lost response");
    },
    resolveToken: tokenResolver(tokens),
  });
  await assert.rejects(transport.createVectorizeIndex({
    account_id: ACCOUNT_ID,
    name: VECTORIZE_NAME,
    dimensions: 768,
    metric: "cosine",
  }), (error) => error instanceof CloudflareDisposableDeploymentTransportError &&
    error.code === "CF_DISPOSABLE_TRANSPORT_MUTATION_AMBIGUOUS");
  assert.equal(calls, 1);
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0].every((byte) => byte === 0));
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CLOUDFLARE_DISPOSABLE_DEPLOYMENT_API_ORIGIN,
  CloudflareDisposableDeploymentTransportError,
  createCloudflareDisposableDeploymentTransport,
} from "../operations/cloudflare-disposable-deployment-transport.mjs";

const ACCOUNT_ID = "a".repeat(32);
const SCRIPT_NAME = "fixture-worker_01";
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
      schedules: [],
    },
    ...overrides,
  };
}

function resourceResponses({ vectorDimensions = 768, workersDevEnabled = true } = {}) {
  return [
    jsonResponse(envelope([{ id: SCRIPT_NAME, routes: [] }])),
    jsonResponse(envelope({ enabled: workersDevEnabled, previews_enabled: false })),
    jsonResponse(envelope({ schedules: [] })),
    jsonResponse(envelope([], {
      count: 0,
      page: 1,
      per_page: 20,
      total_count: 2,
      total_pages: 0,
    })),
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
  assert.deepEqual(calls.map((call) => call.method), Array(7).fill("GET"));
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/subdomain`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules`,
    `/client/v4/accounts/${ACCOUNT_ID}/workers/domains`,
    `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`,
    `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_NAME}`,
    `/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_NAME}/info`,
  ]);
  assert.deepEqual([...new URL(calls[3].url).searchParams],
    [["service", SCRIPT_NAME]]);
  assert.deepEqual([...new URL(calls[4].url).searchParams], [["fields", "uuid,name"]]);
  assert.equal(result.worker_exists, true);
  assert.equal(result.d1_name_and_id_exact, true);
  assert.equal(result.vectorize_name_exact, true);
  assert.equal(result.vector_dimensions, 768);
  assert.equal(result.vector_metric, "cosine");
  assert.equal(result.vector_count, 0);
  assert.equal(result.routes_count, 0);
  assert.equal(result.custom_domains_count, 0);
  assert.equal(result.schedules_count, 0);
  assert.equal(result.responses.length, 7);
  assert.deepEqual(result.responses.map((entry) => entry.operation), [
    "list_workers",
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
  assert.equal(tokens.length, 1, "one bounded read set uses one short-lived token");
  assert.ok(tokens[0].every((byte) => byte === 0));
});

test("resource contract accepts Cloudflare's deprecated custom-domain environment as optional", async () => {
  const responses = resourceResponses();
  responses[3] = jsonResponse(envelope([{
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

test("resource contract refuses provider mismatch after complete readback", async () => {
  const calls = [];
  const transport = createCloudflareDisposableDeploymentTransport({
    fetchImpl: capturedFetch(resourceResponses({ vectorDimensions: 1024 }), calls),
    resolveToken: () => Buffer.from(TOKEN),
  });
  await assert.rejects(transport.readResourceContract(resourceRequest()),
    /CF_DISPOSABLE_TRANSPORT_RESOURCE_MISMATCH/);
  assert.equal(calls.length, 6,
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

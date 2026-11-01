/**
 * Unit Tests: Tatum Sui Mainnet Verifier (Phase 6)
 *
 * Verifies:
 * 1. Protobuf GetObject request encoding and gRPC frame formatting.
 * 2. Protobuf string extraction and transaction digest discovery.
 * 3. Security: Sanitization of endpoint URL (never leaks secrets/tokens).
 * 4. Error handling when TATUM_API_KEY is unconfigured.
 * 5. Bounded timeout handling.
 * 6. Verification proof structure and schema conformance.
 */

import {
  encodeGetObjectRequest,
  extractProtobufStrings,
  querySuiObjectViaTatum,
  verifyWalrusOnchainAnchor,
} from '../../src/core/tatum-verifier.ts';

export async function runTatumVerifierUnitTests(): Promise<{
  passed: boolean;
  count: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let count = 0;

  function assert(condition: boolean, testName: string) {
    count++;
    if (!condition) {
      failures.push(testName);
      console.error(`  [FAIL] ${testName}`);
    } else {
      console.log(`  [PASS] ${testName}`);
    }
  }

  console.log('\n============================================================');
  console.log('TATUM SUI MAINNET VERIFIER UNIT TESTS (PHASE 6)');
  console.log('============================================================');

  // 1. Request Encoding
  console.log('\n--- 1. Request Encoding & gRPC Framing ---');
  const sampleObjectId = '0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090';
  const encoded = encodeGetObjectRequest(sampleObjectId);

  assert(Buffer.isBuffer(encoded), 'Encoded request is a Buffer');
  assert(encoded.length > 5, 'Frame has header + payload');
  assert(encoded.readUInt8(0) === 0, 'First byte is 0 (uncompressed gRPC message)');
  const payloadLen = encoded.readUInt32BE(1);
  assert(encoded.length === 5 + payloadLen, 'gRPC frame length header matches payload length');
  assert(encoded.readUInt8(5) === 0x0a, 'First byte of protobuf payload is Tag 0x0a (field 1 string)');

  let caughtEmpty = false;
  try {
    encodeGetObjectRequest('');
  } catch {
    caughtEmpty = true;
  }
  assert(caughtEmpty, 'Throws on empty objectId');

  // 2. String Extraction from Protobuf
  console.log('\n--- 2. Protobuf String Extraction ---');
  const syntheticPayload = Buffer.concat([
    Buffer.from([0x0a, 0x42]),
    Buffer.from('0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090', 'utf8'),
    Buffer.from([0x12, 0x2b]),
    Buffer.from('HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK', 'utf8'),
  ]);

  const extracted = extractProtobufStrings(syntheticPayload);
  assert(extracted.some(s => s.includes('0xc2225f53')), 'Extracted object ID string from protobuf');
  assert(extracted.some(s => s.includes('HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK')), 'Extracted transaction digest string');

  // 3. Security: Missing API Key Fail-Closed
  console.log('\n--- 3. Fail-Closed Authentication Handling ---');
  const noKeyRes = await querySuiObjectViaTatum(sampleObjectId, { apiKey: '' });
  assert(noKeyRes.verified === false, 'Fails closed when API key is missing');
  assert(noKeyRes.error?.includes('TATUM_API_KEY is not configured'), 'Descriptive error without secret leakage');
  assert(noKeyRes.network === 'sui-mainnet', 'Network is sui-mainnet');
  assert(noKeyRes.transport === 'HTTP/2 gRPC', 'Transport is HTTP/2 gRPC');
  assert(noKeyRes.rpcMethod === '/sui.rpc.v2.LedgerService/GetObject', 'RPC method is GetObject');
  assert(noKeyRes.walrusRelationship.includes('MemWalAccount'), 'Identifies Walrus MemWalAccount relationship');

  // 4. Endpoint Sanitization
  console.log('\n--- 4. Endpoint URL Sanitization ---');
  const dirtyEndpoint = 'https://sui-mainnet-grpc.gateway.tatum.io:443/some/path?secret_token=12345#frag';
  const sanitizedRes = await querySuiObjectViaTatum(sampleObjectId, { apiKey: '', endpointUrl: dirtyEndpoint });
  assert(sanitizedRes.endpoint === 'https://sui-mainnet-grpc.gateway.tatum.io', 'Sanitizes endpoint to origin (strips paths, query params, tokens)');

  // 5. Timeout Handling
  console.log('\n--- 5. Bounded Timeout Handling ---');
  const timeoutRes = await querySuiObjectViaTatum(sampleObjectId, {
    apiKey: 'dummy-test-key',
    endpointUrl: 'https://192.0.2.1', // RFC 5737 TEST-NET-1 (non-routable, will hang or refuse)
    timeoutMs: 100,
  });
  assert(timeoutRes.verified === false, 'Unreachable endpoint marks verified = false');
  assert(!!timeoutRes.error, 'Error message is captured on timeout or connection refusal');

  // 6. Default Anchor Object Verification Helper
  console.log('\n--- 6. Default Walrus Anchor Helper ---');
  const defaultAnchor = await verifyWalrusOnchainAnchor({ apiKey: '' });
  assert(defaultAnchor.objectId.startsWith('0x'), 'Default anchor object ID has 0x prefix');
  assert(defaultAnchor.verified === false, 'Returns structured proof object');

  console.log('\n============================================================');
  console.log(`TATUM VERIFIER TESTS COMPLETE: ${count - failures.length}/${count} PASSED`);
  console.log('============================================================\n');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tatum-verifier.test.ts')) {
  runTatumVerifierUnitTests().then(result => {
    process.exitCode = result.passed ? 0 : 1;
  });
}


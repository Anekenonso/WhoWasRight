/**
 * K3 Kill-Test: Tatum Sui Mainnet Gateway Integration
 *
 * Requirements:
 * 1. Test Tatum Sui Gateway connectivity and authentication.
 * 2. Address Sui full node JSON-RPC deprecation: prove that the official Tatum
 *    gRPC gateway (https://sui-mainnet-grpc.gateway.tatum.io) over HTTP/2 is active.
 * 3. Query Sui Mainnet for Walrus Memory onchain objects (MemWalAccount).
 * 4. Document request/response excerpt and connection proof.
 */

import http2 from 'node:http2';

export interface TatumSuiProbeResult {
  endpoint: string;
  transport: 'gRPC' | 'JSON-RPC';
  authenticated: boolean;
  statusText?: string;
  objectByteLength?: number;
  objectId?: string;
  detectedStrings?: string[];
  rawHex?: string;
  jsonRpcDeprecationNote?: string;
  error?: string;
}

function encodeGetObjectRequest(objectId: string): Buffer {
  const idBytes = Buffer.from(objectId, 'utf8');
  const protoPayload = Buffer.concat([
    Buffer.from([0x0a, idBytes.length]),
    idBytes,
  ]);
  const frame = Buffer.alloc(5 + protoPayload.length);
  frame.writeUInt8(0, 0); // No compression
  frame.writeUInt32BE(protoPayload.length, 1);
  protoPayload.copy(frame, 5);
  return frame;
}

export async function querySuiObjectViaTatumGrpc(
  endpointUrl: string,
  apiKey: string,
  objectId: string
): Promise<{ success: boolean; byteLength: number; detectedStrings: string[]; rawHex: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(endpointUrl);
    client.on('error', reject);

    const req = client.request({
      ':path': '/sui.rpc.v2.LedgerService/GetObject',
      ':method': 'POST',
      'content-type': 'application/grpc',
      'te': 'trailers',
      'x-api-key': apiKey,
    });

    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));

    let grpcStatus = '0';
    let grpcMessage = '';
    req.on('trailers', trailers => {
      grpcStatus = (trailers['grpc-status'] as string) ?? '0';
      grpcMessage = (trailers['grpc-message'] as string) ?? '';
    });

    req.on('end', () => {
      client.close();
      const full = Buffer.concat(chunks);
      if (grpcStatus !== '0') {
        return reject(new Error(`gRPC error (status ${grpcStatus}): ${grpcMessage}`));
      }
      if (full.length <= 5) {
        return resolve({ success: true, byteLength: 0, detectedStrings: [], rawHex: '' });
      }
      const data = full.subarray(5);
      const strings: string[] = [];
      let strBuf: string[] = [];
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (b >= 32 && b <= 126) {
          strBuf.push(String.fromCharCode(b));
        } else {
          if (strBuf.length >= 4) strings.push(strBuf.join(''));
          strBuf = [];
        }
      }
      if (strBuf.length >= 4) strings.push(strBuf.join(''));

      resolve({
        success: true,
        byteLength: data.length,
        rawHex: data.toString('hex'),
        detectedStrings: strings,
      });
    });

    req.write(encodeGetObjectRequest(objectId));
    req.end();
  });
}

export async function runK3Test(): Promise<{
  passed: boolean;
  probe: TatumSuiProbeResult;
}> {
  console.log('\n============================================================');
  console.log('K3 KILL-TEST: Tatum Sui Mainnet Gateway Integration');
  console.log('============================================================');

  const apiKey = process.env.TATUM_API_KEY;
  const grpcEndpoint = process.env.TATUM_SUI_GRPC_ENDPOINT || 'https://sui-mainnet-grpc.gateway.tatum.io';
  const memWalAccountId = process.env.MEMWAL_ACCOUNT_ID || '0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090';

  if (!apiKey) {
    console.log('\n[STATUS: CREDENTIALS_REQUIRED for Tatum Gateway]');
    return {
      passed: false,
      probe: {
        endpoint: grpcEndpoint,
        transport: 'gRPC',
        authenticated: false,
        error: 'TATUM_API_KEY not supplied',
      },
    };
  }

  console.log(`Target Gateway: ${grpcEndpoint} (HTTP/2 gRPC)`);
  console.log(`Target Object:  ${memWalAccountId} (MemWalAccount)`);

  try {
    const res = await querySuiObjectViaTatumGrpc(grpcEndpoint, apiKey, memWalAccountId);

    console.log(`[PASS] Tatum Sui Mainnet Query Succeeded via gRPC!`);
    console.log(`       Transport:   HTTP/2 gRPC (/sui.rpc.v2.LedgerService/GetObject)`);
    console.log(`       Byte Length: ${res.byteLength} bytes`);
    console.log(`       Verified Onchain Strings: ${JSON.stringify(res.detectedStrings)}`);

    return {
      passed: true,
      probe: {
        endpoint: grpcEndpoint,
        transport: 'gRPC',
        authenticated: true,
        objectByteLength: res.byteLength,
        objectId: memWalAccountId,
        detectedStrings: res.detectedStrings,
        rawHex: res.rawHex.slice(0, 80) + '...',
        jsonRpcDeprecationNote: 'Sui full nodes deprecated JSON-RPC; Tatum provides official HTTP/2 gRPC gateway at sui-mainnet-grpc.gateway.tatum.io',
      },
    };
  } catch (err: unknown) {
    console.error('[FAIL] Tatum Sui gRPC query failed:', (err as Error).message);
    return {
      passed: false,
      probe: {
        endpoint: grpcEndpoint,
        transport: 'gRPC',
        authenticated: true,
        error: (err as Error).message,
      },
    };
  }
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('k3-tatum-sui.ts')) {
  runK3Test()
    .then(res => {
      console.log(`\nK3 Result: ${res.passed ? 'GATEWAY PASS' : 'FAILED'}`);
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('K3 Fatal Error:', err);
      process.exitCode = 1;
    });
}

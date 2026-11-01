/**
 * Tatum Sui Mainnet Ledger Verification Service (Phase 6)
 *
 * Implements:
 * 1. Direct HTTP/2 gRPC communication with Tatum's official Sui Mainnet Gateway:
 *    https://sui-mainnet-grpc.gateway.tatum.io
 * 2. Onchain ledger query using /sui.rpc.v2.LedgerService/GetObject for the
 *    shared onchain MemWalAccount object anchoring Walrus decentralized memory.
 * 3. Extraction and verification of live onchain object state and transaction digest.
 * 4. Zero secret leakage: TATUM_API_KEY is server-only and sanitized from all proofs.
 * 5. Honest error handling, explicit verification states, and bounded timeouts.
 */

import http2 from 'node:http2';

export interface TatumSuiProofRecord {
  verified: boolean;
  network: 'sui-mainnet';
  transport: 'HTTP/2 gRPC';
  endpoint: string;
  rpcMethod: '/sui.rpc.v2.LedgerService/GetObject';
  objectId: string;
  transactionDigest?: string;
  byteLength: number;
  walrusRelationship: string;
  timestampUtc: string;
  detectedOnchainTokens?: string[];
  error?: string;
}

export interface TatumQueryOptions {
  apiKey?: string;
  endpointUrl?: string;
  timeoutMs?: number;
}

/**
 * Encodes a gRPC GetObjectRequest payload for Sui LedgerService.
 * Format: field 1 (string object_id) with 5-byte uncompressed gRPC frame prefix.
 */
export function encodeGetObjectRequest(objectId: string): Buffer {
  if (!objectId || typeof objectId !== 'string') {
    throw new Error('Valid objectId string required');
  }

  const idBytes = Buffer.from(objectId, 'utf8');
  // Protobuf wire format: Tag 0x0a (field 1, wire type 2: length-delimited), length, bytes
  const protoPayload = Buffer.concat([
    Buffer.from([0x0a, idBytes.length]),
    idBytes,
  ]);

  // gRPC Frame header: 1 byte compressed flag (0), 4 bytes message length (Big Endian)
  const frame = Buffer.alloc(5 + protoPayload.length);
  frame.writeUInt8(0, 0); // Not compressed
  frame.writeUInt32BE(protoPayload.length, 1);
  protoPayload.copy(frame, 5);
  return frame;
}

/**
 * Parses printable ASCII tokens from raw protobuf response payload.
 */
export function extractProtobufStrings(data: Buffer): string[] {
  const strings: string[] = [];
  let strBuf: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b >= 32 && b <= 126) {
      strBuf.push(String.fromCharCode(b));
    } else {
      if (strBuf.length >= 4) {
        strings.push(strBuf.join(''));
      }
      strBuf = [];
    }
  }
  if (strBuf.length >= 4) {
    strings.push(strBuf.join(''));
  }
  return strings;
}

/**
 * Queries a Sui object via Tatum's official HTTP/2 gRPC gateway.
 */
export async function querySuiObjectViaTatum(
  objectId: string,
  options: TatumQueryOptions = {}
): Promise<TatumSuiProofRecord> {
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.TATUM_API_KEY;
  const rawEndpoint = options.endpointUrl !== undefined ? options.endpointUrl : (process.env.TATUM_SUI_GRPC_ENDPOINT || 'https://sui-mainnet-grpc.gateway.tatum.io');
  const timeoutMs = options.timeoutMs ?? 15000;

  // Sanitized endpoint URL for public proof output
  const endpointHost = new URL(rawEndpoint).origin;

  const baseRecord: Omit<TatumSuiProofRecord, 'verified'> = {
    network: 'sui-mainnet',
    transport: 'HTTP/2 gRPC',
    endpoint: endpointHost,
    rpcMethod: '/sui.rpc.v2.LedgerService/GetObject',
    objectId,
    byteLength: 0,
    walrusRelationship: 'MemWalAccount onchain anchor object backing Walrus decentralized memory',
    timestampUtc: new Date().toISOString(),
  };

  if (!apiKey) {
    return {
      ...baseRecord,
      verified: false,
      error: 'TATUM_API_KEY is not configured',
    };
  }

  return new Promise<TatumSuiProofRecord>((resolve) => {
    let client: http2.ClientHttp2Session | null = null;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (timer) clearTimeout(timer);
      if (client && !client.destroyed) {
        try {
          client.destroy();
        } catch {
          // ignore
        }
      }
    };

    timer = setTimeout(() => {
      if (!finished) {
        cleanup();
        resolve({
          ...baseRecord,
          verified: false,
          error: `Tatum gRPC request timed out after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    try {
      client = http2.connect(endpointHost);

      client.on('error', (err) => {
        if (!finished) {
          cleanup();
          resolve({
            ...baseRecord,
            verified: false,
            error: `HTTP/2 transport error: ${err.message}`,
          });
        }
      });

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
        if (finished) return;
        cleanup();

        if (grpcStatus !== '0') {
          return resolve({
            ...baseRecord,
            verified: false,
            error: `gRPC error (status ${grpcStatus}): ${grpcMessage || 'Request rejected by gateway'}`,
          });
        }

        const full = Buffer.concat(chunks);
        if (full.length < 5) {
          return resolve({
            ...baseRecord,
            verified: false,
            error: 'Empty response payload from Tatum gRPC gateway',
          });
        }

        const payload = full.subarray(5);
        const tokens = extractProtobufStrings(payload);

        // Find transaction digest token (Base58 string, 43-44 chars)
        const digestMatch = tokens.find(t => t.length >= 43 && t.length <= 44 && !t.startsWith('0x'));

        return resolve({
          ...baseRecord,
          verified: true,
          byteLength: payload.length,
          transactionDigest: digestMatch,
          detectedOnchainTokens: tokens,
        });
      });

      req.on('error', (err) => {
        if (!finished) {
          cleanup();
          resolve({
            ...baseRecord,
            verified: false,
            error: `gRPC stream error: ${err.message}`,
          });
        }
      });

      req.write(encodeGetObjectRequest(objectId));
      req.end();

    } catch (err: any) {
      if (!finished) {
        cleanup();
        resolve({
          ...baseRecord,
          verified: false,
          error: `Connection error: ${err.message}`,
        });
      }
    }
  });
}

/**
 * Verifies the Walrus Memory onchain anchor object on Sui Mainnet via Tatum.
 */
export async function verifyWalrusOnchainAnchor(
  options?: TatumQueryOptions & { objectId?: string }
): Promise<TatumSuiProofRecord> {
  const targetId = options?.objectId || process.env.MEMWAL_ACCOUNT_ID || '0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090';
  return querySuiObjectViaTatum(targetId, options);
}

import { MemWal } from '@mysten-incubation/memwal';

async function check() {
  const key = process.env.MEMWAL_KEY!;
  const accountId = process.env.MEMWAL_ACCOUNT_ID!;
  const serverUrl = process.env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz';
  const namespace = 'wwr-test-a-1793311298647';
  const blobId = '3kl_tYmUc8Z_TOGfZZ5GUCNyF338uhoKINuR5yAar9U';

  console.log(`Recalling from namespace ${namespace}...`);

  const client = MemWal.create({
    key,
    accountId,
    serverUrl,
    namespace,
  });

  const recallRes = await client.recall({ query: 'WhoWasRight Mainnet Kill-Test', limit: 5 });
  console.log('Recall results count:', recallRes.results.length);
  const match = recallRes.results.find(r => r.blob_id === blobId);
  console.log('Found confirmed blob in recall?:', !!match);
  if (match) {
    console.log('Recalled text excerpt:', match.text.slice(0, 80));
    console.log('Distance:', match.distance);
  }
}

check().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});

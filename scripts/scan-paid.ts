// Who is being paid to call what? Same scan Crumbs runs daily, on demand.
//   npm run scan-paid            (100 blocks over ~4.5 h)
//   npm run scan-paid -- 30      (quicker)
import { jsonRpc, paidScanText, scanPaidChores } from '../src/discovery/paidScan.js';

const blocks = Number(process.argv[2] ?? 100);
const r = await scanPaidChores(jsonRpc(process.env.DISCOVERY_LISTING_RPC_URL || 'https://api.mainnet-beta.solana.com'), { blocks });
console.log(paidScanText(r.blocks, r.groups, r.groups.length));
for (const g of r.groups) console.log(`${g.calls}\t${g.payers}\t${g.medianNetLamports}\t${g.program}\t${g.name ?? g.discriminator}\t${g.example}`);

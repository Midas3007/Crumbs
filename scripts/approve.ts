// Approve / reject / list job types without Telegram:  npm run approve -- tuktuk.run_task [reject]
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/core/ledger.js';

const [type, action = 'approve'] = process.argv.slice(2);
const ledger = new Ledger(loadConfig().dbPath);
if (!type) {
  for (const j of ledger.listJobTypes()) console.log(`${j.status.padEnd(9)} ${j.type}  (${j.protocol})`);
} else if (ledger.setJobTypeStatus(type, action === 'reject' ? 'rejected' : 'approved')) {
  console.log(`${type} -> ${action === 'reject' ? 'rejected' : 'approved'}`);
} else {
  console.error(`unknown job type ${type} — start the agent once so it registers its job types`);
  process.exit(1);
}

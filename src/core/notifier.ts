import { log } from './logger.js';

export interface ApprovalRequest {
  jobType: string;
  protocol: string;
  description: string;
  rewardSource: string;
  evidence?: string;
}

/** How the agent talks to its owner. Telegram in production, the log otherwise. */
export interface Notifier {
  alert(text: string): Promise<void>;
  requestApproval(req: ApprovalRequest): Promise<void>;
}

export class LogNotifier implements Notifier {
  async alert(text: string) {
    log.warn('ALERT', { text });
  }
  async requestApproval(req: ApprovalRequest) {
    log.warn('APPROVAL NEEDED — run `npm run approve -- <type>` or approve on Telegram', { ...req });
  }
}

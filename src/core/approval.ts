import type { Ledger } from './ledger.js';
import type { ApprovalRequest, Notifier } from './notifier.js';

/**
 * A new job type has appeared. With auto-approve on (the owner's choice) it goes live at once and the
 * owner gets a message with a one-tap Reject; otherwise it waits for Approve. A type the owner rejected
 * stays rejected.
 */
export async function newJobType(ledger: Ledger, notifier: Notifier, autoApprove: boolean, req: ApprovalRequest): Promise<void> {
  const status = ledger.jobTypeStatus(req.jobType);
  if (status === 'rejected' || status === 'approved') return;
  if (autoApprove) ledger.setJobTypeStatus(req.jobType, 'approved');
  await notifier.requestApproval({ ...req, autoApproved: autoApprove });
}

const styles = {
  success: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  pending: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  failed: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  active: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  // Deposit statuses
  PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PENDING_VERIFICATION: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  UNDER_REVIEW: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  CREDITED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  REJECTED: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  // Sell order statuses
  PAYMENT_PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PAYMENT_PROOF_UPLOADED: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  COMPLETED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  CANCELLED: 'bg-gray-500/10 text-gray-500 dark:bg-gray-500/15 dark:text-gray-400',
  MANUAL_REVIEW: 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/15 dark:text-purple-400',
};

const labels = {
  PENDING: 'Pending',
  PENDING_VERIFICATION: 'Under Verification',
  UNDER_REVIEW: 'Under Review',
  CREDITED: 'Credited',
  REJECTED: 'Rejected',
  PAYMENT_PENDING: 'Payment Pending',
  PAYMENT_PROOF_UPLOADED: 'Proof Uploaded',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  MANUAL_REVIEW: 'Manual Review',
};

export function StatusBadge({ status }) {
  const span = document.createElement('span');
  span.className = `inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status] || styles.pending}`;
  span.textContent = labels[status] || status;
  return span;
}

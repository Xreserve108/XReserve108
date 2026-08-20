import { StatusBadge } from './StatusBadge';

const icons = {
  deposit: `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m0 0l6.75-6.75M12 19.5l-6.75-6.75"/></svg>`,
  sell: `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>`,
};

export function TransactionItem(tx) {
  const div = document.createElement('div');
  div.className = 'card card-interactive flex items-center gap-3.5 p-4';

  const isDeposit = tx.type === 'deposit';
  const icon = icons[tx.type] || icons.deposit;
  const sign = isDeposit ? '+' : '−';

  const iconWrap = document.createElement('div');
  iconWrap.className = `flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${isDeposit ? 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400' : 'bg-black/[0.04] text-text-primary dark:bg-white/[0.06] dark:text-text-primary-dark'}`;
  iconWrap.innerHTML = icon;

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';
  info.innerHTML = `
    <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${tx.title}</p>
    <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">${tx.date}</p>
  `;

  const right = document.createElement('div');
  right.className = 'flex flex-col items-end gap-1.5 flex-shrink-0';
  const amount = document.createElement('p');
  amount.className = 'text-[14px] font-semibold text-text-primary dark:text-text-primary-dark';
  amount.textContent = `${sign}${tx.amount} ${tx.currency}`;
  right.appendChild(amount);
  right.appendChild(StatusBadge({ status: tx.status }));

  div.append(iconWrap, info, right);
  return div;
}

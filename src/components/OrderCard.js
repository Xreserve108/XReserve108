import { StatusBadge } from './StatusBadge';

export function OrderCard(order) {
  const div = document.createElement('div');
  div.className = 'card card-interactive p-4';
  // Stable key for in-place status refresh (no re-render needed)
  if (order.key) div.dataset.orderId = order.key;
  div.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <span class="text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">${order.id}</span>
      <span class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${order.date}</span>
    </div>
    <div class="flex items-center justify-between">
      <div>
        <p class="text-[20px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">${order.usdtAmount} USDT</p>
        <p class="mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark">${
          order.rate ? `Rate: ${order.rate} → ₹${order.inrAmount}` : order.subtitle || ''
        }</p>
      </div>
    </div>
  `;
  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'order-badge-slot mt-3';
  badgeWrap.appendChild(StatusBadge({ status: order.status }));
  div.appendChild(badgeWrap);
  return div;
}

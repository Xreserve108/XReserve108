import { TransactionItem } from '@/components/TransactionItem';
import { getWalletBalance, getTransactions } from '@/data/wallet-data';

export async function renderWallet() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Wallet</h1>
    <p class="text-muted mt-1 mb-6">Your USDT balance and transactions</p>

    <div class="card p-6 mb-5">
      <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Available Balance</p>
      <p id="wallet-balance" class="mt-2 text-[36px] font-bold leading-none tracking-tight text-text-primary dark:text-text-primary-dark">-- <span class="text-[18px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span></p>
    </div>

    <div class="flex gap-3 mb-8">
      <a href="#deposit" class="btn-primary flex-1 text-center">Deposit</a>
      <a href="#sell" class="btn-secondary flex-1 text-center">Sell</a>
    </div>

    <section>
      <h2 class="section-heading mb-4">Transactions</h2>
      <div class="stagger flex flex-col gap-3" id="transaction-list"></div>
    </section>
  `;

  // Fetch real data from database (RLS-scoped to authenticated user)
  const [balance, transactions] = await Promise.all([
    getWalletBalance(),
    getTransactions(),
  ]);

  // Update balance display
  if (balance) {
    const balanceEl = page.querySelector('#wallet-balance');
    balanceEl.textContent = '';
    balanceEl.appendChild(document.createTextNode(formatAmount(balance.available)));
    const unit = document.createElement('span');
    unit.className = 'text-[18px] font-medium text-text-secondary dark:text-text-secondary-dark';
    unit.textContent = 'USDT';
    balanceEl.appendChild(unit);
  }

  // Render transaction list
  const list = page.querySelector('#transaction-list');
  if (transactions.length > 0) {
    transactions.forEach((tx) => {
      list.appendChild(TransactionItem(tx));
    });
  } else {
    list.innerHTML = '<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">No transactions yet</p>';
  }

  return page;
}

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

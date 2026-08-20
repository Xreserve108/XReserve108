export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel, destructive = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-5';
  overlay.innerHTML = `
    <div class="card w-full max-w-sm p-6 step-enter">
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">${title}</h3>
      <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark mb-6">${message}</p>
      <div class="flex gap-3">
        <button class="btn-secondary flex-1" id="confirm-cancel">Cancel</button>
        <button class="${destructive ? 'bg-red-600 hover:bg-red-700' : ''} btn-primary flex-1" id="confirm-ok">${confirmLabel}</button>
      </div>
    </div>
  `;

  overlay.querySelector('#confirm-cancel').addEventListener('click', () => {
    overlay.remove();
    if (onCancel) onCancel();
  });

  overlay.querySelector('#confirm-ok').addEventListener('click', () => {
    overlay.remove();
    if (onConfirm) onConfirm();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      if (onCancel) onCancel();
    }
  });

  return overlay;
}

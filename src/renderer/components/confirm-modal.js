export function showConfirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', secondaryLabel = null, danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';

    const primaryCls = danger ? 'btn-danger' : 'btn-primary';
    const secondaryBtn = secondaryLabel
      ? `<button class="btn-ghost" data-action="secondary">${escapeHtml(secondaryLabel)}</button>`
      : '';

    overlay.innerHTML = `
      <div class="modal-body confirm-body">
        <h2>${escapeHtml(title)}</h2>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          ${secondaryBtn}
          <button class="${primaryCls}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    confirmBtn.focus();

    function close(result) {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close('cancel');
      else if (e.key === 'Enter') close('confirm');
    }
    window.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action) close(action);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

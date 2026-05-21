export function promptInline({ container, inline, placeholder = '', initialValue = '', paddingLeft = 8 }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.className = 'ft-inline-input';
    input.placeholder = placeholder;
    input.value = initialValue;

    let placedNode;
    let originalText;

    if (inline) {
      originalText = inline.textContent;
      inline.textContent = '';
      inline.appendChild(input);
      placedNode = inline;
    } else if (container) {
      const row = document.createElement('div');
      row.className = 'ft-entry ft-file';
      row.style.paddingLeft = `${paddingLeft}px`;
      row.innerHTML = `<span class="ft-chev ft-chev-empty"></span><span class="ft-icon"></span>`;
      row.appendChild(input);
      container.prepend(row);
      placedNode = row;
    }

    let done = false;
    function cleanup() {
      done = true;
      if (inline) {
        placedNode.textContent = originalText;
      } else {
        placedNode.remove();
      }
    }

    input.addEventListener('keydown', (e) => {
      if (done) return;
      if (e.key === 'Enter') {
        const val = input.value.trim();
        cleanup();
        resolve(val || null);
      } else if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    });
    input.addEventListener('blur', () => {
      if (done) return;
      const val = input.value.trim();
      cleanup();
      resolve(val || null);
    });

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

// KiddieGPT marketing site — interactions

// ── Mobile nav toggle ─────────────────────────────────────────────
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => links.classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !links.contains(e.target)) links.classList.remove('open');
  });
})();

// ── Waitlist form ─────────────────────────────────────────────────
// 🔧 To wire up real email collection, replace `handleWaitlistLocal` with
// a fetch to your form endpoint (Formspree, Buttondown, ConvertKit, your own).
(function () {
  const forms = document.querySelectorAll('[data-waitlist]');
  forms.forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.querySelector('input[type=email]').value.trim();
      if (!email) return;

      // Local-only "save" for demo. Replace with a real endpoint when ready.
      const result = await handleWaitlistLocal(email);

      if (result.ok) {
        form.classList.add('success');
        form.querySelector('input').value = '';
        form.querySelector('input').placeholder = '🎉 You\'re on the list!';
        showToast('Added to waitlist — we\'ll email you at launch.');

        // 🔧 Real version would look like this:
        // await fetch('https://formspree.io/f/YOUR_ID', {
        //   method: 'POST',
        //   headers: { 'Accept': 'application/json' },
        //   body: new FormData(form),
        // });
      } else {
        showToast('Something went wrong — try again.');
      }
    });
  });

  async function handleWaitlistLocal(email) {
    try {
      const existing = JSON.parse(localStorage.getItem('kgpt_waitlist') || '[]');
      if (!existing.includes(email)) existing.push(email);
      localStorage.setItem('kgpt_waitlist', JSON.stringify(existing));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
})();

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Pricing toggle (monthly / yearly) ──────────────────────────────
(function () {
  const toggle = document.querySelector('.pricing-toggle');
  if (!toggle) return;
  const buttons = toggle.querySelectorAll('button');
  const pill = toggle.querySelector('.toggle-pill');

  function movePill(activeBtn) {
    if (!pill) return;
    pill.style.width = activeBtn.offsetWidth + 'px';
    pill.style.transform = `translateX(${activeBtn.offsetLeft - 4}px)`;
  }
  // Initial pill position
  const initActive = toggle.querySelector('button.active') || buttons[0];
  requestAnimationFrame(() => movePill(initActive));

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      movePill(btn);
      const mode = btn.dataset.mode; // 'monthly' | 'yearly'
      document.querySelectorAll('[data-price]').forEach((el) => {
        const m = el.dataset.priceMonthly;
        const y = el.dataset.priceYearly;
        if (m && y) el.textContent = mode === 'yearly' ? y : m;
      });
      document.querySelectorAll('[data-billing]').forEach((el) => {
        const m = el.dataset.billingMonthly;
        const y = el.dataset.billingYearly;
        if (m && y) el.textContent = mode === 'yearly' ? y : m;
      });
    });
  });
  window.addEventListener('resize', () => movePill(toggle.querySelector('button.active')));
})();

// ── Scroll reveal ─────────────────────────────────────────────────
(function () {
  const items = document.querySelectorAll('[data-reveal]');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });
  items.forEach((el) => io.observe(el));
})();

// ── Smooth scroll for in-page anchors ─────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

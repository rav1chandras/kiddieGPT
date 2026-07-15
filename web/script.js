// KiddieGPT marketing site — interactions

// ── Mobile nav toggle ─────────────────────────────────────────────
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  function setOpen(open) {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setOpen(!links.classList.contains('open')));
  links.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !links.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
})();

// ── Study journey carousel ────────────────────────────────────────
(function () {
  const carousel = document.querySelector('[data-carousel]');
  if (!carousel) return;

  const slides = Array.from(carousel.querySelectorAll('[data-slide]'));
  const dots = Array.from(carousel.querySelectorAll('[data-carousel-dot]'));
  const previous = carousel.querySelector('[data-carousel-prev]');
  const next = carousel.querySelector('[data-carousel-next]');
  const count = carousel.querySelector('[data-carousel-count]');
  let active = 0;
  let touchStartX = 0;
  let touchStartY = 0;

  slides.forEach((slide, index) => {
    slide.id = `study-slide-${index + 1}`;
    dots[index]?.setAttribute('aria-controls', slide.id);
  });

  function showSlide(index) {
    active = (index + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const selected = slideIndex === active;
      slide.classList.toggle('is-active', selected);
      slide.setAttribute('aria-hidden', String(!selected));
      if ('inert' in slide) slide.inert = !selected;
    });
    dots.forEach((dot, dotIndex) => {
      const selected = dotIndex === active;
      dot.classList.toggle('is-active', selected);
      dot.setAttribute('aria-selected', String(selected));
      dot.tabIndex = selected ? 0 : -1;
    });
    if (count) count.textContent = `${active + 1} / ${slides.length}`;
  }

  dots.forEach((dot, index) => dot.addEventListener('click', () => showSlide(index)));
  previous?.addEventListener('click', () => showSlide(active - 1));
  next?.addEventListener('click', () => showSlide(active + 1));

  carousel.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    showSlide(active + (event.key === 'ArrowRight' ? 1 : -1));
    dots[active]?.focus();
  });

  carousel.addEventListener('touchstart', (event) => {
    touchStartX = event.changedTouches[0].clientX;
    touchStartY = event.changedTouches[0].clientY;
  }, { passive: true });

  carousel.addEventListener('touchend', (event) => {
    const deltaX = event.changedTouches[0].clientX - touchStartX;
    const deltaY = event.changedTouches[0].clientY - touchStartY;
    if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    showSlide(active + (deltaX < 0 ? 1 : -1));
  }, { passive: true });

  showSlide(0);
})();

// ── Contact form and lightweight bot protection ───────────────────
(function () {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;

  const subject = form.elements.subject;
  const message = form.elements.message;
  const honeypot = form.elements._gotcha;
  const captcha = form.elements.captcha;
  const question = form.querySelector('[data-captcha-question]');
  const subjectCount = form.querySelector('[data-subject-count]');
  const bodyCount = form.querySelector('[data-body-count]');
  const status = form.querySelector('[data-contact-status]');
  const submitButton = form.querySelector('button[type="submit"]');
  let startedAt = Date.now();
  let captchaAnswer = 0;

  function refreshCaptcha() {
    const firstNumber = Math.floor(Math.random() * 7) + 2;
    const secondNumber = Math.floor(Math.random() * 7) + 2;
    captchaAnswer = firstNumber + secondNumber;
    question.textContent = `${firstNumber} + ${secondNumber}`;
  }

  refreshCaptcha();

  function updateCounts() {
    subjectCount.textContent = subject.value.length;
    bodyCount.textContent = message.value.length;
  }

  const requestedSubject = new URLSearchParams(window.location.search).get('subject');
  if (requestedSubject) subject.value = requestedSubject.slice(0, 30);
  updateCounts();
  subject.addEventListener('input', updateCounts);
  message.addEventListener('input', updateCounts);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.className = 'contact-status';

    if (honeypot.value || Date.now() - startedAt < 3500) {
      status.textContent = 'We could not verify this submission. Please wait a moment and try again.';
      status.classList.add('is-error');
      return;
    }

    if (!form.checkValidity()) {
      form.reportValidity();
      status.textContent = 'Please complete every field.';
      status.classList.add('is-error');
      return;
    }

    if (Number(captcha.value) !== captchaAnswer) {
      status.textContent = 'That human-check answer is not correct. Please try again.';
      status.classList.add('is-error');
      captcha.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.classList.add('is-sending');
    submitButton.firstChild.textContent = 'Sending… ';
    status.textContent = 'Sending your message securely…';

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const detail = result.errors?.map((error) => error.message).join(' ') || 'Please try again in a moment.';
        throw new Error(detail);
      }

      form.reset();
      updateCounts();
      refreshCaptcha();
      startedAt = Date.now();
      status.textContent = 'Thanks—your message has been sent to the KiddieGPT team.';
      status.classList.add('is-success');
    } catch (error) {
      status.textContent = `We could not send your message. ${error.message}`;
      status.classList.add('is-error');
    } finally {
      submitButton.disabled = false;
      submitButton.classList.remove('is-sending');
      submitButton.firstChild.textContent = 'Send message ';
    }
  });
})();

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

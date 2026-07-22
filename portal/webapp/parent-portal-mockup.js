document.addEventListener('DOMContentLoaded', () => {
  const title = document.querySelector('[data-page-title]');
  const subtitle = document.querySelector('[data-page-subtitle]');
  const profileModal = document.querySelector('#profile-modal');
  const profileForm = document.querySelector('#profile-form');
  let currentScreen = 'overview';
  let currentProfileIndex = 0;

  const profiles = [
    {
      name: 'Ava Patel',
      grade: 'Grade 6',
      readingLevel: 'Confident reader',
      initials: 'AP',
      status: 'On track',
      goals: [
        { icon: 'check', title: 'Finish two science explanations', detail: 'Completed yesterday', state: 'Done', done: true },
        { icon: 'book-open', title: 'Practice fractions for 15 minutes', detail: 'Next up in Math Step Tutor', state: 'Today', done: false },
        { icon: 'message-circle', title: 'Ask one thoughtful question', detail: 'Build curiosity through chat', state: 'This week', done: false }
      ],
      reward: 'Movie night with Mom',
      rewardProgress: '2 of 3 goals'
    }
  ];

  const titles = {
    overview: ['Good evening, Maya'],
    subscription: ['Family workspace', 'Manage access, billing, and renewals.'],
    support: ['Family workspace', 'Help for your family account.']
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

  const closeProfileModal = () => {
    if (profileModal) profileModal.hidden = true;
    if (profileForm) profileForm.reset();
  };

  const updateHeader = () => {
    if (!title || !subtitle) return;
    if (currentScreen === 'overview') {
      const firstName = profiles[currentProfileIndex].name.split(' ')[0];
      title.textContent = titles.overview[0];
      subtitle.textContent = `Here is the latest on ${firstName}'s learning journey.`;
      return;
    }
    const copy = titles[currentScreen] || titles.overview;
    title.textContent = copy[0];
    subtitle.textContent = copy[1] || '';
  };

  const renderProfile = () => {
    const profile = profiles[currentProfileIndex];
    const initials = document.querySelector('[data-profile-initials]');
    const name = document.querySelector('[data-profile-name]');
    const details = document.querySelector('[data-profile-details]');
    const status = document.querySelector('[data-profile-status]');
    const count = document.querySelector('[data-profile-count]');
    const goalCount = document.querySelector('[data-profile-goal-count]');
    const goals = document.querySelector('[data-profile-goals]');
    const reward = document.querySelector('[data-profile-reward]');
    const rewardProgress = document.querySelector('[data-profile-reward-progress]');
    const studentCount = document.querySelector('[data-student-count]');
    const focusMessage = document.querySelector('[data-focus-message]');
    const previous = document.querySelector('[data-profile-prev]');
    const next = document.querySelector('[data-profile-next]');
    const add = document.querySelector('[data-open-profile-modal]');

    if (initials) initials.textContent = profile.initials;
    if (name) name.textContent = profile.name;
    if (details) details.innerHTML = `${escapeHtml(profile.grade)} <b>&bull;</b> ${escapeHtml(profile.readingLevel)}`;
    if (status) status.textContent = profile.status;
    if (count) count.textContent = `${currentProfileIndex + 1} of 3`;
    if (goalCount) goalCount.textContent = `${profile.goals.length} ${profile.goals.length === 1 ? 'goal' : 'goals'}`;
    if (studentCount) studentCount.textContent = `${profiles.length} active ${profiles.length === 1 ? 'profile' : 'profiles'}`;
    if (focusMessage) {
      focusMessage.textContent = profile === profiles[0]
        ? 'Ava has completed 5 of 7 planned learning sessions.'
        : `${profile.name.split(' ')[0]}'s learning profile is ready for a first session.`;
    }
    if (reward) reward.textContent = profile.reward;
    if (rewardProgress) rewardProgress.textContent = profile.rewardProgress;
    if (previous) previous.disabled = profiles.length < 2 || currentProfileIndex === 0;
    if (next) next.disabled = profiles.length < 2 || currentProfileIndex === profiles.length - 1;
    if (add) {
      add.disabled = profiles.length >= 3;
      add.title = profiles.length >= 3 ? 'Maximum of 3 student profiles' : 'Add student profile';
    }

    if (goals) {
      goals.innerHTML = profile.goals.map((goal) => `
        <div class="goal-row">
          <span class="goal-check ${goal.done ? 'is-done' : ''}"><i data-lucide="${escapeHtml(goal.icon)}" aria-hidden="true"></i></span>
          <span class="goal-copy"><strong>${escapeHtml(goal.title)}</strong><small>${escapeHtml(goal.detail)}</small></span>
          <span class="goal-state ${goal.done ? 'done' : ''}">${escapeHtml(goal.state)}</span>
        </div>
      `).join('');
    }

    updateHeader();
    if (window.lucide) window.lucide.createIcons();
  };

  const showScreen = (screenName) => {
    currentScreen = screenName;
    document.querySelectorAll('[data-screen]').forEach((screen) => {
      screen.classList.toggle('is-active', screen.dataset.screen === screenName);
    });
    document.querySelectorAll('[data-screen-target]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.screenTarget === screenName);
    });
    updateHeader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openProfileModal = () => {
    if (!profileModal || profiles.length >= 3) return;
    profileModal.hidden = false;
    const nameInput = profileModal.querySelector('[name="studentName"]');
    if (nameInput) nameInput.focus();
  };

  document.querySelectorAll('[data-screen-target]').forEach((item) => {
    item.addEventListener('click', () => showScreen(item.dataset.screenTarget));
  });

  document.querySelectorAll('[data-open-profile-modal]').forEach((item) => {
    item.addEventListener('click', openProfileModal);
  });

  document.querySelectorAll('[data-close-profile-modal]').forEach((item) => {
    item.addEventListener('click', closeProfileModal);
  });

  if (profileModal) {
    profileModal.addEventListener('click', (event) => {
      if (event.target === profileModal) closeProfileModal();
    });
  }

  const previous = document.querySelector('[data-profile-prev]');
  const next = document.querySelector('[data-profile-next]');
  if (previous) previous.addEventListener('click', () => {
    if (currentProfileIndex > 0) {
      currentProfileIndex -= 1;
      renderProfile();
    }
  });
  if (next) next.addEventListener('click', () => {
    if (currentProfileIndex < profiles.length - 1) {
      currentProfileIndex += 1;
      renderProfile();
    }
  });

  if (profileForm) {
    profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (profiles.length >= 3) return;
      const formData = new FormData(profileForm);
      const name = String(formData.get('studentName') || '').trim();
      const grade = String(formData.get('grade') || '').trim();
      const readingLevel = String(formData.get('readingLevel') || '').trim();
      const learningPlan = String(formData.get('learningPlan') || '').trim();
      if (!name || !grade || !readingLevel || !learningPlan) return;
      profiles.push({
        name,
        grade,
        readingLevel,
        initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        status: 'New',
        goals: [{ icon: 'book-open', title: learningPlan, detail: 'Added today', state: 'New', done: false }],
        reward: 'Add a reward',
        rewardProgress: 'Optional'
      });
      currentProfileIndex = profiles.length - 1;
      renderProfile();
      closeProfileModal();
      showScreen('overview');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && profileModal && !profileModal.hidden) closeProfileModal();
  });

  renderProfile();
});

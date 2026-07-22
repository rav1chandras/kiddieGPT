(function () {
  var STORAGE_KEY = "kiddiegptFamilies";
  var PRICING_KEY = "kiddiegptPricing";
  var ADMIN_TOKEN_KEY = "kiddiegptAdminToken";

  // Status chips start hidden so screens are not littered with idle "Ready"
  // pills. Any code that writes textContent reveals the chip automatically,
  // so the many call sites did not need touching.
  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.forEach.call(document.querySelectorAll(".state-chip[hidden]"), function (chip) {
      var proto = Object.getPrototypeOf(chip);
      var desc = Object.getOwnPropertyDescriptor(proto, "textContent") ||
        Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
      if (!desc || !desc.set) return;
      Object.defineProperty(chip, "textContent", {
        configurable: true,
        get: function () { return desc.get.call(this); },
        set: function (value) { desc.set.call(this, value); this.hidden = !String(value || "").trim(); }
      });
    });
  });
  var ACTIVE_PLAN_KEY = "kiddiegptActivePlan";
  var PENDING_CHECKOUT_PLAN_KEY = "kiddiegptPendingCheckoutPlan";
  var PARENT_TOKEN_KEY = "kiddiegptParentToken";
  var allowedParentEmailDomains = ["gmail.com", "yahoo.com", "aol.com", "outlook.com", "hotmail.com"];
  var googleClientId = "";
  var selectedFamilyId = null;
  var familiesCache = [];
  var pricingCache = null;
  var auditLogsCache = [];
  var monitorEventsCache = [];
  var emailLogsCache = [];
  var paymentsCache = [];
  var aiSettingsCache = null;
  var deletedUserSequence = 0;
  var backendReady = false;

  function adminToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
  }

  function parentToken() {
    return localStorage.getItem(PARENT_TOKEN_KEY) || "";
  }

  function authedHeaders(headers) {
    var next = Object.assign({}, headers || {});
    var token = adminToken();
    if (token) next.Authorization = "Bearer " + token;
    return next;
  }

  function apiFetch(url, options) {
    var next = Object.assign({}, options || {});
    next.headers = authedHeaders(next.headers);
    return fetch(url, next);
  }

  function parentAuthFetch(url, options) {
    var next = Object.assign({}, options || {});
    var headers = Object.assign({}, next.headers || {});
    var token = parentToken();
    if (token) headers.Authorization = "Bearer " + token;
    next.headers = headers;
    return fetch(url, next);
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function parentEmailAllowed(email) {
    var domain = normalizeEmail(email).split("@")[1] || "";
    return allowedParentEmailDomains.indexOf(domain) >= 0;
  }

  function parentEmailHint() {
    return "Supported email providers: Gmail, Yahoo, AOL, Outlook, and Hotmail.";
  }

  function readFamilies() {
    if (backendReady) return familiesCache.slice();
    try {
      familiesCache = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return familiesCache.slice();
    } catch (error) {
      return [];
    }
  }

  function writeFamilies(families) {
    familiesCache = families.slice();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(families));
    if (backendReady) {
      apiFetch("/api/admin/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ families: familiesCache })
      }).catch(function () {});
    }
  }

  function makeId() {
    return "fam_" + Math.random().toString(36).slice(2, 10);
  }

  function text(value) {
    return value == null || value === "" ? "-" : String(value);
  }

  function moneyPlan() {
    return "Family Monthly";
  }

  function defaultPricing() {
    return {
      monthly: {
        label: "Family Monthly",
        amount: 19,
        interval: "mo",
        stripePriceId: "price_demo_monthly",
        familyMemberCount: 3,
        active: true
      },
      yearly: {
        label: "Family Yearly",
        amount: 149,
        interval: "yr",
        stripePriceId: "price_demo_yearly",
        familyMemberCount: 3,
        active: true
      },
      promotion: {
        enabled: true,
        code: "SAVE50",
        monthlyAmount: 10,
        yearlyAmount: 75,
        planKey: "monthly",
        price: "",
        description: "Limited-time family starter offer",
        showAfterDays: 3,
        durationDays: 7
      },
      yearlyUpgrade: {
        bonusMonths: 3,
        discountAmount: 0,
        note: ""
      },
      cancellationPromo: {
        enabled: true,
        amountOff: 0,
        duration: "once",
        description: "Keep your plan and save on the next renewal."
      }
    };
  }

  // Keep in step with legacyAmountOff() in lib/app.js.
  function legacyAmountOff(amount, legacyPercent, planAmount) {
    var dollars = Math.max(0, Number(amount) || 0);
    if (dollars > 0) return dollars;
    var percent = Math.max(0, Math.min(100, Number(legacyPercent) || 0));
    var base = Math.max(0, Number(planAmount) || 0);
    if (percent <= 0 || base <= 0) return 0;
    return Math.round(base * percent) / 100;
  }

  function normalisePricingForClient(pricing) {
    var defaults = defaultPricing();
    var rawPromotion = pricing && pricing.promotion ? pricing.promotion : {};
    var rawYearlyUpgrade = pricing && pricing.yearlyUpgrade ? pricing.yearlyUpgrade : {};
    var rawCancellationPromo = pricing && pricing.cancellationPromo ? pricing.cancellationPromo : {};
    var monthly = Object.assign(defaults.monthly, pricing && pricing.monthly || {});
    var yearly = Object.assign(defaults.yearly, pricing && pricing.yearly || {});
    var promotion = Object.assign(defaults.promotion, rawPromotion);
    var cancellationPromo = Object.assign(defaults.cancellationPromo, rawCancellationPromo);
    var hasMonthlyAmount = Object.prototype.hasOwnProperty.call(rawPromotion, "monthlyAmount");
    var hasYearlyAmount = Object.prototype.hasOwnProperty.call(rawPromotion, "yearlyAmount");
    var hasLegacyPrice = Object.prototype.hasOwnProperty.call(rawPromotion, "price") && rawPromotion.price !== "";
    var legacyPlanKey = rawPromotion.planKey === "yearly" ? "yearly" : "monthly";
    // Older records stored one `price`; new records retain both plan overrides.
    if (!hasMonthlyAmount && !hasYearlyAmount && hasLegacyPrice) {
      promotion.monthlyAmount = legacyPlanKey === "monthly" ? Number(rawPromotion.price || 0) : 0;
      promotion.yearlyAmount = legacyPlanKey === "yearly" ? Number(rawPromotion.price || 0) : 0;
    } else {
      promotion.monthlyAmount = hasMonthlyAmount ? Number(rawPromotion.monthlyAmount || 0) : Number(promotion.monthlyAmount || 0);
      promotion.yearlyAmount = hasYearlyAmount ? Number(rawPromotion.yearlyAmount || 0) : Number(promotion.yearlyAmount || 0);
    }
    promotion.planKey = promotion.planKey === "yearly" ? "yearly" : "monthly";
    promotion.price = promotion.planKey === "yearly" ? promotion.yearlyAmount : promotion.monthlyAmount;
    if (Number(promotion.monthlyAmount || 0) <= 0 && Number(promotion.yearlyAmount || 0) > 0) promotion.planKey = "yearly";
    promotion.enabled = promotion.enabled !== false;
    // Each plan carries its own code. Records written before the split have a
    // single `code`, which seeds both so an existing promotion keeps working.
    promotion.monthlyCode = String(rawPromotion.monthlyCode || rawPromotion.code || "").trim();
    promotion.yearlyCode = String(rawPromotion.yearlyCode || rawPromotion.code || "").trim();
    promotion.code = promotion.monthlyCode || promotion.yearlyCode;
    delete promotion.discountPercent;
    delete promotion.endDate;
    var yearlyUpgrade = Object.assign({}, defaults.yearlyUpgrade, rawYearlyUpgrade);
    yearlyUpgrade.bonusMonths = Math.max(0, Math.round(Number(yearlyUpgrade.bonusMonths) || 0));
    // Mirrors legacyAmountOff() on the server. The server normalises what it
    // serves, but pricing is cached in localStorage, so a copy stored before the
    // dollar-discount switch can still reach this code with a percentage.
    yearlyUpgrade.discountAmount = legacyAmountOff(yearlyUpgrade.discountAmount, yearlyUpgrade.discountPercent, yearly.amount);
    delete yearlyUpgrade.discountPercent;
    yearlyUpgrade.note = String(yearlyUpgrade.note || "");
    cancellationPromo.enabled = cancellationPromo.enabled !== false;
    cancellationPromo.amountOff = legacyAmountOff(cancellationPromo.amountOff, cancellationPromo.percentOff, monthly.amount);
    delete cancellationPromo.percentOff;
    cancellationPromo.duration = cancellationPromo.duration === "repeating" ? "repeating" : "once";
    cancellationPromo.description = String(cancellationPromo.description || "");
    return { monthly: monthly, yearly: yearly, promotion: promotion, yearlyUpgrade: yearlyUpgrade, cancellationPromo: cancellationPromo };
  }

  function readPricing() {
    if (pricingCache) return JSON.parse(JSON.stringify(pricingCache));
    try {
      var saved = JSON.parse(localStorage.getItem(PRICING_KEY) || "{}");
      return normalisePricingForClient(saved);
    } catch (error) {
      return defaultPricing();
    }
  }

  function writePricing(pricing) {
    pricingCache = JSON.parse(JSON.stringify(pricing));
    localStorage.setItem(PRICING_KEY, JSON.stringify(pricing));
    return apiFetch("/api/pricing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pricing)
    }).then(async function (response) {
      var payload = await response.json();
      if (!response.ok) throw payload;
      pricingCache = payload;
      localStorage.setItem(PRICING_KEY, JSON.stringify(payload));
      return payload;
    });
  }

  async function loadBackendState() {
    try {
      var response = await apiFetch("/api/admin/state");
      if (!response.ok) throw new Error("Backend state unavailable");
      var state = await response.json();
      familiesCache = Array.isArray(state.families) ? state.families : [];
      pricingCache = state.pricing || defaultPricing();
      auditLogsCache = Array.isArray(state.auditLogs) ? state.auditLogs : [];
      monitorEventsCache = Array.isArray(state.monitorEvents) ? state.monitorEvents : [];
      emailLogsCache = Array.isArray(state.emailLogs) ? state.emailLogs : [];
      paymentsCache = Array.isArray(state.payments) ? state.payments : [];
      deletedUserSequence = Number(state.deletedUserSequence || 0);
      backendReady = true;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(familiesCache));
      localStorage.setItem(PRICING_KEY, JSON.stringify(pricingCache));
      return state;
    } catch (error) {
      backendReady = false;
      familiesCache = readFamilies();
      try {
        var pricingResponse = await fetch("/api/pricing");
        if (pricingResponse.ok) {
          pricingCache = await pricingResponse.json();
          localStorage.setItem(PRICING_KEY, JSON.stringify(pricingCache));
        } else {
          pricingCache = readPricing();
        }
      } catch (pricingError) {
        pricingCache = readPricing();
      }
      return { families: familiesCache, pricing: pricingCache };
    }
  }

  async function createFamilyOnBackend(family) {
    try {
      var response = await fetch("/api/families", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(family)
      });
      if (!response.ok) throw await response.json();
      var saved = await response.json();
      await loadBackendState();
      return saved;
    } catch (error) {
      var families = readFamilies();
      families.unshift(family);
      writeFamilies(families);
      return family;
    }
  }

  async function patchFamilyOnBackend(familyId, patch) {
    try {
      var response = await apiFetch("/api/admin/families/" + encodeURIComponent(familyId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) throw await response.json();
      var saved = await response.json();
      await loadBackendState();
      return saved;
    } catch (error) {
      return null;
    }
  }

  async function deleteChildOnBackend(childId) {
    var response = await parentAuthFetch("/api/parent/family/children/" + encodeURIComponent(childId), { method: "DELETE" });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to remove the student profile.");
    return result;
  }

  function formatPlanPrice(plan, promoAmount) {
    var amount = promoAmount != null && promoAmount !== "" ? Number(promoAmount) : Number(plan.amount);
    return "$" + amount + "/" + plan.interval;
  }

  function priceLabelMarkup(plan, promoAmount) {
    var base = Number(plan.amount);
    var amount = promoAmount != null && promoAmount !== "" ? Number(promoAmount) : Number(plan.amount);
    var interval = "<span>/" + plan.interval + "</span>";
    if (promoAmount != null && promoAmount !== "" && amount > 0 && amount < base) {
      return "<s>$" + base + interval + "</s><em>$" + amount + interval + "</em>";
    }
    return "<em>$" + amount + interval + "</em>";
  }

  function planLabelForKey(key) {
    return key === "yearly" ? "Yearly" : "Monthly";
  }

    function selectedPlanKeyFromInputs(inputs) {
      var selected = inputs.find(function (input) { return input.checked; });
      return selected ? selected.value : "monthly";
    }

    function parentDate(value) {
      if (!value) return "the end of the paid period";
      // A unix-seconds timestamp read as milliseconds lands in January 1970, and
      // an unparseable one renders "Invalid Date" — neither belongs in front of
      // a parent, so treat both as "no known date".
      var raw = typeof value === "number" || /^\d+$/.test(String(value).trim())
        ? Number(value) * 1000
        : value;
      var when = new Date(raw);
      var stamp = when.getTime();
      if (!Number.isFinite(stamp) || stamp < 86400000) return "the end of the paid period";
      return when.toLocaleDateString([], {
        month: "long",
        day: "numeric",
        year: "numeric"
      });
    }

    function parentDateFromUnix(value) {
      var seconds = Number(value || 0);
      return seconds ? parentDate(new Date(seconds * 1000).toISOString()) : "";
    }

  function promotionPlanKey(promo) {
    return promo && promo.planKey === "yearly" ? "yearly" : "monthly";
  }

  function promotionAmountForPlan(promo, key) {
    if (!promo) return null;
    var hasPlanAmount = key === "yearly" ? promo.yearlyAmount != null : promo.monthlyAmount != null;
    var amount = hasPlanAmount
      ? Number(key === "yearly" ? promo.yearlyAmount : promo.monthlyAmount)
      : promotionPlanKey(promo) === key ? Number(promo.price || 0) : 0;
    return amount > 0 ? amount : null;
  }

  function promotionEndDateText(value) {
    if (!value) return "";
    var date = new Date(value + "T00:00:00");
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function promotionExpired(value) {
    if (!value) return false;
    var end = new Date(value + "T23:59:59").getTime();
    return Number.isFinite(end) && Date.now() > end;
  }

  function renderIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function setupParentPortal() {
    var form = document.getElementById("onboarding-form");
    if (!form) return;

    var finish = document.getElementById("finish");
    var paymentState = document.getElementById("payment-state");
    var cap = document.getElementById("usage-cap");
    var capLabel = document.getElementById("usage-cap-label");
    var completionPanel = document.getElementById("completion-panel");
    var completionTitle = document.getElementById("completion-title");
    var completionText = document.getElementById("completion-text");
    var profileSaveState = document.getElementById("profile-save-state");
    var childList = document.getElementById("student-workspace-slides");
    var addChild = document.getElementById("add-child");
    var previousChild = document.getElementById("previous-child");
    var nextChild = document.getElementById("next-child");
    var childPosition = document.getElementById("child-position");
    var tabButtons = Array.from(document.querySelectorAll("[data-parent-tab]"));
    var panels = Array.from(document.querySelectorAll("[data-parent-panel]"));
    var demoButtons = Array.from(document.querySelectorAll("[data-demo-account]"));
    var planInputs = Array.from(document.querySelectorAll('[name="planChoice"]'));
    var subscriptionMain = document.getElementById("subscription-main");
    var cancelFlow = document.getElementById("cancel-flow");
    var cancelSubscription = document.getElementById("cancel-subscription");
    var resumeSubscription = document.getElementById("resume-subscription");
    var backToSubscription = document.getElementById("back-to-subscription");
    var saveOffer = document.getElementById("save-offer");
    var cancelFlowLabel = document.getElementById("cancel-flow-label");
    var cancelFlowTitle = document.getElementById("cancel-flow-title");
    var cancelFlowCopy = document.getElementById("cancel-flow-copy");
    var acceptDiscount = document.getElementById("accept-discount");
    var confirmCancel = document.getElementById("confirm-cancel");
    var cancelReason = document.getElementById("cancel-reason");
    var cancellationYearlyOption = document.getElementById("cancellation-yearly-option");
    var cancelSwitchYearly = document.getElementById("cancel-switch-yearly");
    var updatePaymentMethod = document.getElementById("update-payment-method");
    var promoOfferCard = document.getElementById("promo-offer-card");
    var promoOfferCode = document.getElementById("promo-offer-code");
    var promoOfferDescription = document.getElementById("promo-offer-description");
    var promoOfferWindow = document.getElementById("promo-offer-window");
    var copyPromoCode = document.getElementById("copy-promo-code");
    var promoState = document.getElementById("promo-state");
    var subscriptionTitle = document.getElementById("subscription-title");
    var currentPackageCard = document.getElementById("current-package-card");
    var currentPackageName = document.getElementById("current-package-name");
    var currentPackagePrice = document.getElementById("current-package-price");
    var currentPackageNote = document.getElementById("current-package-note");
    var subscriptionFineprint = document.querySelector(".subscription-fineprint");
    var upgradeYearly = document.getElementById("upgrade-yearly");
    var promoRow = document.getElementById("promo-offer-card");
    var planTileGrid = document.querySelector(".plan-tile-grid");
    var planSelectionSurface = document.querySelector(".upgrade-plan");
    var upgradePlanSurface = document.getElementById("upgrade-plan-surface");
    var upgradePlanKicker = document.getElementById("upgrade-plan-kicker");
    var upgradePlanTitle = document.getElementById("upgrade-plan-title");
    var upgradeYearlyContent = document.getElementById("upgrade-yearly-content");
    var upgradeYearlyName = document.getElementById("upgrade-yearly-name");
    var upgradeYearlyPromo = document.getElementById("upgrade-yearly-promo");
    var upgradeYearlyPrice = document.getElementById("upgrade-yearly-price");
    var upgradeYearlyCopy = document.getElementById("upgrade-yearly-copy");
    var upgradeYearlyBonus = document.getElementById("upgrade-yearly-bonus");
    var upgradeYearlyBillingNote = document.getElementById("upgrade-yearly-billing-note");
    var upgradeYearlyTileButton = document.getElementById("upgrade-yearly-tile-button");
    var parentAccountName = document.getElementById("parent-account-name");
    var parentAccountPlan = document.getElementById("parent-account-plan");
    var parentSideStatus = document.getElementById("parent-side-status");
    var parentSideNote = document.getElementById("parent-side-note");
    var googleLoginButton = document.getElementById("google-login-button");
    var authDomainHint = document.getElementById("auth-domain-hint");
    var parentAuthGate = document.getElementById("parent-auth-gate");
    var parentLoginForm = document.getElementById("parent-login-form");
    var parentLoginError = document.getElementById("parent-login-error");
    var parentDemoLogin = document.querySelector("[data-parent-demo-login]");
    var parentLogout = document.getElementById("parent-logout");
    var parentAuthSubmit = document.getElementById("parent-auth-submit");
    var parentAuthModeToggle = document.getElementById("parent-auth-mode-toggle");
    var parentEmailRow = document.getElementById("parent-email-row");
    var parentPasswordRow = document.getElementById("parent-password-row");
    var parentAuthModeButtons = Array.from(document.querySelectorAll("[data-parent-auth-mode]"));
    var parentSignupFields = Array.from(document.querySelectorAll(".signup-only"));
    var parentOtpFields = Array.from(document.querySelectorAll(".otp-only"));
    var parentResetConfirmFields = Array.from(document.querySelectorAll(".reset-confirm-only"));
    var parentResetFlowFields = Array.from(document.querySelectorAll(".reset-flow-only"));
    var parentLoginOnlyFields = Array.from(document.querySelectorAll(".login-only"));
    var forgotPasswordButton = document.getElementById("forgot-password");
    var backToLoginButton = document.getElementById("back-to-login");
    var resendOtpButton = document.getElementById("resend-otp");
    var parentAuthTitle = document.getElementById("parent-auth-title");
    var parentAuthCopy = document.getElementById("parent-auth-copy");
    var accountActionStatus = document.getElementById("account-action-status");
    var changePasswordButton = document.getElementById("change-password");
    var requestEmailChangeButton = document.getElementById("request-email-change");
    var confirmEmailChangeButton = document.getElementById("confirm-email-change");
    var requestDeleteAccountButton = document.getElementById("request-delete-account");
    var currentPasswordInput = document.getElementById("current-password");
    var newPasswordInput = document.getElementById("new-password");
    var newParentEmailInput = document.getElementById("new-parent-email");
    var emailChangeCodeInput = document.getElementById("email-change-code");
    var parentAuthMode = "login";
    var pendingOtpEmail = "";
    var pendingResetEmail = "";
    var activePromo = null;
    var activePlanKey = localStorage.getItem(ACTIVE_PLAN_KEY) || "monthly";
    var signedInParentEmail = "";
    var parentEntitlement = null;
    var parentRenewalAt = "";
    var retentionOfferAccepted = false;
    var yearlyUpgradeScheduled = false;
    var yearlyUpgradeInfo = null;
    var cancellationScheduled = false;
    var cancellationAccessUntil = "";
    var paid = false;
    var activeChildIndex = 0;
    var lastProgressData = null;
    var deleteProfileCandidate = null;

    var demos = {
      parent: {
        parentName: "Maya Patel",
        email: "parent.kiddiegpt@gmail.com",
        password: "kiddiegpt123",
        studentName: "Ava",
        grade: "Grade 5",
        readingLevel: "2",
        goals: [
          { goal: "Build confidence in math word problems", reward: "Movie night", completed: false },
          { goal: "Read 20 minutes four days this week", reward: "Saturday pancakes", completed: true }
        ]
      },
      student: {
        parentName: "Jordan Lee",
        email: "jordan.kiddiegpt@outlook.com",
        password: "kiddiegpt123",
        studentName: "Noah",
        grade: "Grade 7",
        readingLevel: "3",
        goals: [
          { goal: "Practice reading, writing, and study habits", reward: "New basketball shoes", completed: false }
        ]
      }
    };

    function setParentTab(name) {
      tabButtons.forEach(function (button) {
        var active = button.dataset.parentTab === name;
        button.classList.toggle("active", active);
        button.classList.toggle("is-active", active);
      });
      panels.forEach(function (panel) {
        var active = panel.dataset.parentPanel === name;
        panel.classList.toggle("active", active);
        panel.classList.toggle("is-active", active);
      });
      // The kicker ("Family overview" / "Family workspace") repeated what the
      // sidebar already said, so each page is just title + subtitle now. Support
      // took over the heading its own screen used to duplicate below the fold.
      var pageCopy = {
        overview: ["Good evening, " + ((formValue("parentName") || "there").split(" ")[0]) + "", "Here is the latest on your child's learning journey."],
        subscription: ["Manage subscription", "Billing, access, and renewals in one place."],
        support: ["Account help", "Password, profile changes, and privacy requests all live here."]
      }[name];
      if (pageCopy) {
        var title = document.getElementById("live-page-title");
        var subtitle = document.getElementById("live-page-subtitle");
        if (title) title.textContent = pageCopy[0];
        if (subtitle) subtitle.textContent = pageCopy[1];
      }
      if (name === "overview" || name === "progress") { loadProgress(); }
      if (name === "support") { loadSupport(); }
      renderIcons();
    }

    function relativeSince(iso) {
      var t = iso ? new Date(iso).getTime() : 0;
      if (!t) return "No activity yet";
      var days = Math.floor((Date.now() - t) / 86400000);
      if (days <= 0) return "Today";
      if (days === 1) return "Yesterday";
      if (days < 7) return days + " days ago";
      return parentDate(iso);
    }

    function progressLocalKey(d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function progressLast7Keys() {
      var keys = [];
      var now = new Date();
      for (var i = 6; i >= 0; i--) {
        var x = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        keys.push(progressLocalKey(x));
      }
      return keys;
    }
    // Fold a child's day buckets into totals + per-day action counts + a flat
    // quiz list, mirroring how the extension itself summarizes the week.
    function aggregateProgress(rows) {
      var totals = { lessons: 0, cardsReviewed: 0, mathSolved: 0, tutorLessons: 0, explains: 0, writingChecks: 0, quizzes: 0 };
      var quizzes = [];
      var byDate = {};
      (rows || []).forEach(function (row) {
        var b = row.bucket || {};
        totals.lessons += b.lessons || 0;
        totals.cardsReviewed += b.cardsReviewed || 0;
        totals.mathSolved += b.mathSolved || 0;
        totals.tutorLessons += b.tutorLessons || 0;
        totals.explains += b.explains || 0;
        totals.writingChecks += b.writingChecks || 0;
        var qs = b.quizzes || [];
        totals.quizzes += qs.length;
        qs.forEach(function (q) { quizzes.push(q); });
        var actions = (b.lessons || 0) + (b.cardsReviewed || 0) + (b.mathSolved || 0) +
          (b.tutorLessons || 0) + (b.explains || 0) + (b.writingChecks || 0) + qs.length;
        byDate[row.date] = (byDate[row.date] || 0) + actions;
      });
      return { totals: totals, quizzes: quizzes, byDate: byDate };
    }

    function renderProgressLegacy(data) {
      lastProgressData = data || null;
      var slide = activeStudentSlide();
      var list = slide ? slide.querySelector(".progress-list") : null;
      var chip = slide ? slide.querySelector(".active-chip") : null;
      if (chip) {
        chip.textContent = data && data.active ? ((data.plan && data.plan.name) || "Active") : "No active plan";
        chip.className = "state-chip " + (data && data.active ? "ok" : "warning");
      }
      if (!list) return;
      var children = (data && data.children) || [];
      if (!children.length) {
        list.innerHTML = '<div class="progress-empty">No student activity yet. Add a learning profile and extension activity will appear here.</div>';
        return;
      }
      var selectedProgressChild = activeProgressChild(children);
      if (!selectedProgressChild) {
        list.innerHTML = '<div class="progress-empty">No extension activity yet for this profile.</div>';
        return;
      }
      children = [selectedProgressChild];
      list.innerHTML = children.map(function (c) {
        var agg = aggregateProgress(c.progress);
        var t = agg.totals;
        var totalActions = t.lessons + t.cardsReviewed + t.mathSolved + t.tutorLessons + t.explains + t.writingChecks + t.quizzes;
        var tiles = [
          [t.lessons, "Missions built"],
          [t.cardsReviewed, "Flashcards reviewed"],
          [t.quizzes, "Quizzes taken"],
          [t.mathSolved, "Math problems solved"],
          [t.tutorLessons, "Tutor lessons"],
          [t.explains + t.writingChecks, "Explain &amp; Writing"]
        ].map(function (m) {
          return '<div class="metric"><b>' + m[0] + '</b><span>' + m[1] + '</span></div>';
        }).join("");

        var keys = progressLast7Keys();
        var maxActions = Math.max(1, Math.max.apply(null, keys.map(function (k) { return agg.byDate[k] || 0; })));
        var bars = keys.map(function (k) {
          var acts = agg.byDate[k] || 0;
          var pct = acts ? Math.max(8, Math.round((acts / maxActions) * 100)) : 0;
          var label = new Date(k + "T00:00:00").toLocaleDateString([], { weekday: "short" }).slice(0, 1);
          return '<div class="pc-day"><div class="pc-day-track" title="' + acts + ' action' + (acts === 1 ? "" : "s") + '"><span style="height:' + pct + '%"></span></div><small>' + label + '</small></div>';
        }).join("");

        var recent = agg.quizzes.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 6);
        var quizHtml = recent.length ? recent.map(function (q) {
          var total = q.total || 0;
          var pct = total ? Math.round((q.score / total) * 100) : 0;
          var missed = (q.missed || []).filter(function (m) { return m && m.q; });
          var head = '<div class="pc-quiz-row"><span class="pc-quiz-title">' + text(q.title || "Quiz") + '</span>' +
            '<span class="pc-quiz-score' + (pct >= 80 ? " good" : pct >= 50 ? " ok" : " low") + '">' + q.score + '/' + total + ' · ' + pct + '%</span></div>';
          if (!missed.length) {
            return '<div class="pc-quiz">' + head + '</div>';
          }
          var items = missed.map(function (m) {
            return '<li><span class="mq-q">' + text(m.q) + '</span>' +
              '<span class="mq-a">Correct: <b>' + text(m.answer || "—") + '</b></span>' +
              '<span class="mq-c">Chose: ' + text(m.chosen || "(blank)") + '</span></li>';
          }).join("");
          return '<details class="pc-quiz"><summary>' + head +
            '<span class="pc-review-tag">' + missed.length + ' to review</span></summary>' +
            '<ul class="pc-missed">' + items + '</ul></details>';
        }).join("") : '<div class="pc-quiz-empty">No quizzes yet this week.</div>';

        return '<div class="progress-card">' +
            '<div class="pc-head"><h3>' + text(c.name || "Student") + '</h3>' +
              '<span class="pc-sub">' + text(c.grade || "") + (c.lastExtensionUseAt ? ' · ' + text(relativeSince(c.lastExtensionUseAt)) : "") + '</span></div>' +
            '<div class="progress-tiles">' + tiles + '</div>' +
            (totalActions ?
              '<div class="pc-week"><span class="pc-section-label">Daily activity</span><div class="pc-week-bars">' + bars + '</div></div>' +
              '<div class="pc-quizzes"><span class="pc-section-label">Recent activity</span>' + quizHtml + '</div>'
              : '<div class="pc-quiz-empty">No activity from the extension yet this week.</div>') +
          '</div>';
      }).join("");
      renderIcons();
    }

    function renderProgress(data) {
      lastProgressData = data || null;
      var slide = activeStudentSlide();
      var list = slide ? slide.querySelector(".progress-list") : null;
      if (!list) return;
      var children = (data && data.children) || [];
      var profiles = Array.from(document.querySelectorAll(".child-profile"));
      var selected = activeProgressChild(children);
      var studentCount = document.querySelector("[data-student-count]");
      var profileCount = Math.max(children.length, profiles.length, 1);
      if (studentCount) studentCount.textContent = profileCount + " active " + (profileCount === 1 ? "profile" : "profiles");
      if (!selected) {
        var activeProfile = profiles[activeChildIndex];
        var activeName = activeProfile && activeProfile.querySelector('[name="studentName"]')
          ? activeProfile.querySelector('[name="studentName"]').value.trim()
          : "This student";
        list.innerHTML = '<div class="progress-empty">' + text(activeName || "This student") + "'s progress will appear here after their first extension session." + '</div>';
        return;
      }
      var agg = aggregateProgress(selected.progress);
      var t = agg.totals;
      var totalActions = t.lessons + t.cardsReviewed + t.mathSolved + t.tutorLessons + t.explains + t.writingChecks + t.quizzes;
      var percent = totalActions ? Math.min(100, Math.max(8, Math.round((totalActions / 7) * 100))) : 0;
      var goalCount = Math.max(7, totalActions);
      var completedCount = Math.min(goalCount, totalActions);
      var message = totalActions
        ? text(selected.name || "Your child") + " has completed " + completedCount + " of " + goalCount + " planned learning sessions."
        : "Your child's first learning session will appear here.";
      var keys = progressLast7Keys();
      var maxActions = Math.max(1, Math.max.apply(null, keys.map(function (key) { return agg.byDate[key] || 0; })));
      var bars = keys.map(function (key) {
        var actions = agg.byDate[key] || 0;
        var height = actions ? Math.max(12, Math.round((actions / maxActions) * 100)) : 10;
        var label = new Date(key + "T00:00:00").toLocaleDateString([], { weekday: "short" }).slice(0, 1);
        return '<span class="bar-day"><i' + (actions ? ' style="height:' + height + '%"' : ' class="empty" style="height:10%"') + '></i><small>' + label + '</small></span>';
      }).join("");
      var recent = agg.quizzes.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 3);
      var activity = recent.length ? recent.map(function (quiz, index) {
        var pct = quiz.total ? Math.round((quiz.score / quiz.total) * 100) : 0;
        var icon = index === 0 ? "calculator" : index === 1 ? "file-text" : "lightbulb";
        return '<div class="activity-item"><span class="activity-icon ' + (index === 1 ? 'violet' : index === 2 ? 'orange' : 'green') + '"><i data-lucide="' + icon + '"></i></span><span><strong>' + text(quiz.title || "Quiz completed") + '</strong><small>' + text(quiz.score) + '/' + text(quiz.total) + ' · ' + pct + '%</small></span><time>' + relativeSince(quiz.ts ? new Date(quiz.ts).toISOString() : "") + '</time></div>';
      }).join("") : '<div class="progress-empty">No quizzes yet this week.</div>';
      list.innerHTML = '<div class="progress-focus"><div class="donut" style="--progress:' + percent + '%" aria-label="' + percent + ' percent weekly goal completion"><span><strong>' + percent + '%</strong><small>weekly goal</small></span></div><div class="focus-copy"><strong>' + (percent >= 70 ? 'Nice momentum' : percent ? 'A good start' : 'Ready when you are') + '</strong><p>' + message + '</p><span class="focus-note">' + (percent >= 85 ? "This week's goal is nearly complete." : "One more session keeps the week moving.") + '</span></div></div><div class="mini-bars" aria-label="Weekly activity by day">' + bars + '</div><div class="focus-footer"><span><i data-lucide="clock-3"></i> ' + (totalActions * 12) + ' min learning time</span><span><i data-lucide="trending-up"></i> ' + (totalActions ? 'This week' : 'No activity yet') + '</span></div><div class="embedded-activity"><div class="embedded-activity-heading"><span class="section-kicker">Recent activity</span><span>' + recent.length + ' ' + (recent.length === 1 ? 'session' : 'sessions') + '</span></div><div class="activity-list">' + activity + '</div></div>';
      var streak = document.querySelector("[data-learning-streak]");
      if (streak) {
        var streakDays = Math.min(7, Math.max(1, Object.keys(agg.byDate).length));
        streak.textContent = totalActions ? streakDays + (streakDays === 1 ? " day" : " days") : "Ready to start";
      }
      renderIcons();
    }

    async function loadProgress() {
      if (!parentToken()) return;
      try {
        var res = await parentAuthFetch("/api/account/progress");
        var data = await res.json();
        if (res.ok) renderProgress(data);
      } catch (error) { /* keep empty state */ }
    }

    // Support is deliberately not a chat: replies reach the parent by email only.
    // Rendering a thread here would imply an in-app conversation and set
    // response-time expectations a solo operator cannot meet.
    function renderSupportThread() {
      var el = document.getElementById("support-thread");
      if (el) el.innerHTML = "";
    }

    async function loadSupport() {
      if (!parentToken()) return;
      try {
        var res = await parentAuthFetch("/api/support/messages");
        var data = await res.json();
        if (res.ok) renderSupportThread(data.messages);
      } catch (error) { /* ignore */ }
    }

    async function sendSupportMessage() {
      var msgEl = document.getElementById("support-message");
      var catEl = document.getElementById("support-category");
      var statusEl = document.getElementById("support-status");
      var msg = msgEl ? msgEl.value.trim() : "";
      if (!msg) { if (statusEl) { statusEl.textContent = "Please enter a message."; statusEl.style.color = "#b23a48"; } return; }
      if (statusEl) { statusEl.textContent = "Sending…"; statusEl.style.color = "#6a827d"; }
      try {
        var res = await parentAuthFetch("/api/support/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: catEl ? catEl.value : "Other", message: msg })
        });
        var data = await res.json();
        if (!res.ok) throw data;
        if (msgEl) { msgEl.value = ""; msgEl.dispatchEvent(new Event("input")); }
        if (statusEl) { statusEl.textContent = "Sent — we'll reply by email."; statusEl.style.color = "#0f6e56"; }
        loadSupport();
      } catch (error) {
        if (statusEl) { statusEl.textContent = (error && error.error) || "Could not send. Try again."; statusEl.style.color = "#b23a48"; }
      }
    }

    function applyControls(controls) {
      controls = controls || {};
      var rs = document.getElementById("control-require-steps");
      var ve = document.getElementById("control-voice-enabled");
      var ws = document.getElementById("control-weekly-summary");
      var mc = document.getElementById("control-math-cap");
      if (rs) rs.checked = controls.requireSteps !== false;
      if (ve) ve.checked = controls.voiceEnabled !== false;
      if (ws) ws.checked = controls.weeklySummary !== false;
      if (mc) mc.value = (controls.mathDailyCap === null || controls.mathDailyCap === undefined) ? "" : controls.mathDailyCap;
    }

    async function loadControls() {
      if (!parentToken()) return;
      try {
        var res = await parentAuthFetch("/api/account/controls");
        var data = await res.json();
        if (res.ok) applyControls(data.controls);
      } catch (error) { /* ignore */ }
    }

    async function saveControls() {
      var status = document.getElementById("controls-status");
      var mcEl = document.getElementById("control-math-cap");
      var capRaw = mcEl ? String(mcEl.value).trim() : "";
      if (status) { status.textContent = "Saving…"; status.className = "state-chip"; }
      try {
        var res = await parentAuthFetch("/api/account/controls", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requireSteps: document.getElementById("control-require-steps").checked,
            voiceEnabled: document.getElementById("control-voice-enabled").checked,
            weeklySummary: document.getElementById("control-weekly-summary").checked,
            mathDailyCap: capRaw === "" ? null : Number(capRaw)
          })
        });
        var data = await res.json();
        if (!res.ok) throw data;
        applyControls(data.controls);
        loadProgress();
        if (status) { status.textContent = "Saved"; status.className = "state-chip ok"; }
      } catch (error) {
        if (status) { status.textContent = "Error"; status.className = "state-chip warning"; }
      }
    }

    function formValue(name) {
      return form.elements[name] ? form.elements[name].value : "";
    }

    function resetSubscriptionPanel() {
      if (cancelFlow) cancelFlow.classList.add("hidden");
      if (subscriptionMain) subscriptionMain.classList.remove("hidden");
      if (cancelReason) cancelReason.value = "Too expensive";
    }

    function applySignedInParent(user, family) {
      if (!user) return;
      signedInParentEmail = normalizeEmail(user.email || "");
      resetSubscriptionPanel();
      if (form.elements.email) form.elements.email.value = user.email || form.elements.email.value;
      if (form.elements.parentName) form.elements.parentName.value = user.name || form.elements.parentName.value;
      if (parentAccountName) parentAccountName.textContent = user.name || "Parent";
      validateParentEmail();
      // Load the family's saved children. On session restore the family is
      // already in the response; on fresh login we fetch it.
      if (family) hydrateChildren(family); else loadParentFamily();
      preview();
      loadProgress().catch(function () {});
    }

    function showParentGate(message) {
      document.body.classList.add("parent-locked");
      if (parentAuthGate) parentAuthGate.hidden = false;
      if (parentLoginError) parentLoginError.textContent = message || "";
      renderIcons();
    }

    function hideParentGate() {
      document.body.classList.remove("parent-locked");
      if (parentAuthGate) parentAuthGate.hidden = true;
      if (parentLoginError) parentLoginError.textContent = "";
    }

    function setParentAuthMode(mode) {
      parentAuthMode = mode === "signup" || mode === "otp" || mode === "reset-request" || mode === "reset-confirm" || mode === "reset" ? mode : "login";
      if (parentAuthMode === "reset") parentAuthMode = "reset-request";
      var isResetFlow = parentAuthMode === "reset-request" || parentAuthMode === "reset-confirm";
      parentAuthModeButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.parentAuthMode === (parentAuthMode === "otp" ? "signup" : parentAuthMode));
      });
      if (parentAuthModeToggle) parentAuthModeToggle.classList.toggle("hidden", isResetFlow);
      parentSignupFields.forEach(function (field) {
        field.classList.toggle("hidden", parentAuthMode !== "signup");
        var input = field.querySelector("input");
        if (input) input.required = parentAuthMode === "signup";
      });
      parentOtpFields.forEach(function (field) {
        field.classList.toggle("hidden", parentAuthMode !== "otp");
        var input = field.querySelector("input");
        if (input) input.required = parentAuthMode === "otp";
      });
      parentResetConfirmFields.forEach(function (field) {
        field.classList.toggle("hidden", parentAuthMode !== "reset-confirm");
        var input = field.querySelector("input");
        if (input) input.required = parentAuthMode === "reset-confirm";
      });
      parentResetFlowFields.forEach(function (field) {
        field.classList.toggle("hidden", !isResetFlow);
      });
      parentLoginOnlyFields.forEach(function (field) {
        field.classList.toggle("hidden", parentAuthMode !== "login");
      });
      if (parentEmailRow) parentEmailRow.classList.toggle("hidden", parentAuthMode === "reset-confirm");
      if (parentAuthSubmit) parentAuthSubmit.textContent = parentAuthMode === "otp" ? "Verify email" : parentAuthMode === "signup" ? "Create account" : parentAuthMode === "reset-request" ? "Send reset code" : parentAuthMode === "reset-confirm" ? "Reset password" : "Sign in";
      if (parentAuthTitle) parentAuthTitle.textContent = parentAuthMode === "otp" ? "Verify your email" : parentAuthMode === "signup" ? "Create parent account" : parentAuthMode === "reset-request" ? "Reset password" : parentAuthMode === "reset-confirm" ? "Set new password" : "Parent sign in";
      if (parentAuthCopy) parentAuthCopy.textContent = "";
      if (parentLoginError) parentLoginError.textContent = "";
      if (parentLoginForm && parentLoginForm.elements.password) {
        parentLoginForm.elements.password.autocomplete = parentAuthMode === "signup" ? "new-password" : "current-password";
        parentLoginForm.elements.password.required = parentAuthMode === "login" || parentAuthMode === "signup";
        (parentPasswordRow || parentLoginForm.elements.password.closest("label")).classList.toggle("hidden", parentAuthMode === "otp" || isResetFlow);
      }
      if (googleLoginButton) googleLoginButton.classList.toggle("hidden", parentAuthMode === "otp" || isResetFlow);
      var demoGrid = parentLoginForm ? parentLoginForm.querySelector(".auth-demo-grid") : null;
      if (demoGrid) demoGrid.classList.toggle("hidden", parentAuthMode === "otp" || isResetFlow);
    }

    async function signInParent(email, password) {
      if (parentLoginError) parentLoginError.textContent = "Signing in...";
      var response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "parent", email: normalizeEmail(email), password: password })
      });
      var payload = await response.json();
      if (!response.ok || !payload.token) throw payload;
      localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      applySignedInParent(payload.user);
      hideParentGate();
      syncSubscriptionFromEntitlement().catch(function () {});
      return payload;
    }

    async function signUpParent() {
      if (parentLoginError) parentLoginError.textContent = "Creating account...";
      var email = normalizeEmail(parentLoginForm.elements.email.value);
      var response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: parentLoginForm.elements.parentName ? parentLoginForm.elements.parentName.value.trim() : "Parent",
          email: email,
          password: parentLoginForm.elements.password.value
        })
      });
      var payload = await response.json();
      if (!response.ok || !payload.pendingVerification) throw payload;
      pendingOtpEmail = payload.email || email;
      parentLoginForm.elements.email.value = pendingOtpEmail;
      if (parentLoginForm.elements.otp) parentLoginForm.elements.otp.value = "";
      setParentAuthMode("otp");
      if (parentLoginError) parentLoginError.textContent = payload.message || "Verification code sent.";
      return payload;
    }

    async function verifyParentOtp() {
      if (parentLoginError) parentLoginError.textContent = "Verifying code...";
      var response = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: pendingOtpEmail || normalizeEmail(parentLoginForm.elements.email.value),
          otp: parentLoginForm.elements.otp ? parentLoginForm.elements.otp.value.trim() : ""
        })
      });
      var payload = await response.json();
      if (!response.ok || !payload.token) throw payload;
      localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      applySignedInParent(payload.user);
      hideParentGate();
      completionTitle.textContent = "Email verified";
      completionText.textContent = "Your parent account is ready. Choose a subscription, add child profiles, then save the family setup.";
      completionPanel.classList.add("is-active");
      syncSubscriptionFromEntitlement().catch(function () {});
      return payload;
    }

    async function resendParentOtp() {
      var email = pendingOtpEmail || normalizeEmail(parentLoginForm.elements.email.value);
      if (parentLoginError) parentLoginError.textContent = "Sending a new code...";
      var response = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
      });
      var payload = await response.json();
      if (!response.ok) throw payload;
      if (parentLoginError) parentLoginError.textContent = payload.message || "New verification code sent.";
      return payload;
    }

    async function requestPasswordResetCode() {
      var email = normalizeEmail(parentLoginForm.elements.email.value);
      if (parentLoginError) parentLoginError.textContent = "Sending reset code...";
      var response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
      });
      var payload = await response.json();
      if (!response.ok) throw payload;
      pendingResetEmail = payload.email || email;
      if (parentLoginForm.elements.resetOtp) parentLoginForm.elements.resetOtp.value = "";
      if (parentLoginForm.elements.resetPassword) parentLoginForm.elements.resetPassword.value = "";
      setParentAuthMode("reset-confirm");
      if (parentLoginError) parentLoginError.textContent = payload.message || "Reset code sent.";
      return payload;
    }

    async function resetParentPassword() {
      if (parentLoginError) parentLoginError.textContent = "Resetting password...";
      var response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: pendingResetEmail || normalizeEmail(parentLoginForm.elements.email.value),
          otp: parentLoginForm.elements.resetOtp ? parentLoginForm.elements.resetOtp.value.trim() : "",
          newPassword: parentLoginForm.elements.resetPassword ? parentLoginForm.elements.resetPassword.value : ""
        })
      });
      var payload = await response.json();
      if (!response.ok || !payload.token) throw payload;
      localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      pendingResetEmail = "";
      applySignedInParent(payload.user);
      hideParentGate();
      completionTitle.textContent = "Password reset";
      completionText.textContent = "You are signed in with the new password.";
      completionPanel.classList.add("is-active");
      syncSubscriptionFromEntitlement().catch(function () {});
      return payload;
    }

    function showAccountStatus(message, state) {
      if (!accountActionStatus) return;
      accountActionStatus.textContent = message;
      accountActionStatus.className = "state-chip " + (state || "ready");
    }

    async function changeParentPassword() {
      showAccountStatus("Updating", "warning");
      var response = await parentAuthFetch("/api/account/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: currentPasswordInput ? currentPasswordInput.value : "",
          newPassword: newPasswordInput ? newPasswordInput.value : ""
        })
      });
      var payload = await response.json();
      if (!response.ok) throw payload;
      // The server rotates the token on password change; keep the new one.
      if (payload.token) localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      if (currentPasswordInput) currentPasswordInput.value = "";
      if (newPasswordInput) newPasswordInput.value = "";
      showAccountStatus("Password updated", "ok");
    }

    async function requestParentEmailChange() {
      showAccountStatus("Sending code", "warning");
      var response = await parentAuthFetch("/api/account/request-email-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: newParentEmailInput ? newParentEmailInput.value : "" })
      });
      var payload = await response.json();
      if (!response.ok) throw payload;
      showAccountStatus("Code sent", "ok");
    }

    async function confirmParentEmailChange() {
      showAccountStatus("Confirming", "warning");
      var response = await parentAuthFetch("/api/account/confirm-email-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newEmail: newParentEmailInput ? newParentEmailInput.value : "",
          otp: emailChangeCodeInput ? emailChangeCodeInput.value.trim() : ""
        })
      });
      var payload = await response.json();
      if (!response.ok || !payload.token) throw payload;
      localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      applySignedInParent(payload.user);
      if (newParentEmailInput) newParentEmailInput.value = "";
      if (emailChangeCodeInput) emailChangeCodeInput.value = "";
      showAccountStatus("Email updated", "ok");
    }

    async function requestAccountDeletion() {
      if (!window.confirm("Request account deletion and lock extension access while admin reviews it?")) return;
      showAccountStatus("Recording", "warning");
      var response = await parentAuthFetch("/api/account/delete-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      var payload = await response.json();
      if (!response.ok) throw payload;
      localStorage.removeItem(PARENT_TOKEN_KEY);
      setParentAuthMode("login");
      showParentGate(payload.message || "Account deletion request recorded.");
    }

    function setupParentLoginGate() {
      if (!parentAuthGate || !parentLoginForm) return;
      setParentAuthMode("login");
      showParentGate("");

      parentLoginForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          if (parentAuthMode === "signup") {
            await signUpParent();
          } else if (parentAuthMode === "otp") {
            await verifyParentOtp();
          } else if (parentAuthMode === "reset-request") {
            await requestPasswordResetCode();
          } else if (parentAuthMode === "reset-confirm") {
            await resetParentPassword();
          } else {
            await signInParent(parentLoginForm.elements.email.value, parentLoginForm.elements.password.value);
          }
        } catch (error) {
          showParentGate(error.detail || error.error || (parentAuthMode === "signup" ? "Could not create account. Check the parent email and password." : "Could not sign in. Check the parent email and password."));
        }
      });

      parentAuthModeButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          setParentAuthMode(button.dataset.parentAuthMode);
        });
      });

      document.addEventListener("click", function (event) {
      var tile = event.target.closest ? event.target.closest("[data-demo-email]") : null;
      if (!tile || !parentLoginForm) return;
      setParentAuthMode("login");
      parentLoginForm.elements.email.value = tile.dataset.demoEmail;
      parentLoginForm.elements.password.value = tile.dataset.demoPassword || "";
      parentLoginForm.requestSubmit();
    });

    if (parentDemoLogin) {
        parentDemoLogin.addEventListener("click", function () {
          setParentAuthMode("login");
          parentLoginForm.elements.email.value = "parent.kiddiegpt@gmail.com";
          parentLoginForm.elements.password.value = "kiddiegpt123";
          parentLoginForm.requestSubmit();
        });
      }

      if (resendOtpButton) {
        resendOtpButton.addEventListener("click", function () {
          resendParentOtp().catch(function (error) {
            if (parentLoginError) parentLoginError.textContent = error.error || "Unable to resend code.";
          });
        });
      }

      if (forgotPasswordButton) {
        forgotPasswordButton.addEventListener("click", function () {
          pendingResetEmail = "";
          setParentAuthMode("reset-request");
        });
      }

      if (backToLoginButton) {
        backToLoginButton.addEventListener("click", function () {
          pendingResetEmail = "";
          setParentAuthMode("login");
        });
      }

      if (parentLogout) {
        parentLogout.addEventListener("click", function () {
          localStorage.removeItem(PARENT_TOKEN_KEY);
          resetSubscriptionPanel();
          setParentAuthMode("login");
          showParentGate("Signed out.");
        });
      }

      if (!parentToken()) return;
      parentAuthFetch("/api/auth/me")
        .then(function (response) {
          if (!response.ok) {
            return response.json().catch(function () {
              return { error: "Session expired. Sign in again." };
            }).then(function (payload) {
              throw payload;
            });
          }
          return response.json();
        })
        .then(function (payload) {
          if (!payload.user || payload.user.role !== "parent") throw new Error("wrong role");
          applySignedInParent(payload.user, payload.family);
          hideParentGate();
          syncSubscriptionFromEntitlement().catch(function () {});
        })
        .catch(function (error) {
          localStorage.removeItem(PARENT_TOKEN_KEY);
          showParentGate(error?.error || "Session expired. Sign in again.");
        });
    }

    function showParentAuthMessage(message, state) {
      if (authDomainHint) {
        authDomainHint.textContent = state === "ready" ? "Email is used for login and extension access." : message;
        authDomainHint.className = state ? "auth-domain-hint " + state : "auth-domain-hint";
      }
      if (document.body.classList.contains("parent-locked") && parentLoginError && state === "error") {
        parentLoginError.textContent = message;
      }
      if (completionTitle && state === "error") {
        completionTitle.textContent = message.indexOf("Google") >= 0 ? "Google sign-in setup" : "Check parent email";
        completionText.textContent = message;
      }
    }

    function validateParentEmail() {
      var emailInput = form.elements.email;
      var email = normalizeEmail(formValue("email"));
      if (!email) {
        if (emailInput) emailInput.setCustomValidity("");
        showParentAuthMessage(parentEmailHint(), "ready");
        return true;
      }
      if (!parentEmailAllowed(email)) {
        var message = parentEmailHint();
        if (emailInput) emailInput.setCustomValidity(message);
        showParentAuthMessage(message, "error");
        return false;
      }
      if (emailInput) emailInput.setCustomValidity("");
      showParentAuthMessage(parentEmailHint(), "ready");
      return true;
    }

    // Demo login tiles, driven entirely by /api/auth/config: the server decides
    // whether they exist at all, so a real deployment never renders one-click
    // logins. Built with DOM APIs rather than innerHTML — escapeHtml() lives in
    // the admin scope and is not reachable here.
    function renderDemoLogins(config) {
      var grid = document.querySelector(".auth-demo-grid");
      if (!grid) return;
      if (!config.demoLogins) { grid.remove(); return; }
      var accounts = Array.isArray(config.demoAccounts) ? config.demoAccounts : [];
      if (!accounts.length) return;
      grid.textContent = "";
      accounts.forEach(function (account) {
        var tile = document.createElement("button");
        tile.type = "button";
        tile.className = "auth-demo-tile";
        tile.dataset.demoEmail = account.email;
        tile.dataset.demoPassword = account.password || "";
        var icon = document.createElement("i");
        icon.setAttribute("data-lucide", account.icon || "user-round");
        var label = document.createElement("span");
        label.textContent = account.label || "Demo";
        var email = document.createElement("strong");
        email.textContent = account.email;
        var note = document.createElement("em");
        note.textContent = account.note || "";
        tile.append(icon, label, email, note);
        grid.appendChild(tile);
      });
      var admin = document.createElement("a");
      admin.className = "auth-demo-tile";
      admin.href = "/admin.html";
      var adminIcon = document.createElement("i");
      adminIcon.setAttribute("data-lucide", "layout-dashboard");
      var adminLabel = document.createElement("span");
      adminLabel.textContent = "Admin console";
      var adminEmail = document.createElement("strong");
      adminEmail.textContent = "admin@kiddiegpt.demo";
      var adminNote = document.createElement("em");
      adminNote.textContent = "Operator view";
      admin.append(adminIcon, adminLabel, adminEmail, adminNote);
      grid.appendChild(admin);
      renderIcons();
    }

    async function loadAuthConfig() {
      try {
        var response = await fetch("/api/auth/config");
        var config = await response.json();
        if (Array.isArray(config.allowedParentEmailDomains) && config.allowedParentEmailDomains.length) {
          allowedParentEmailDomains = config.allowedParentEmailDomains;
        }
        googleClientId = config.googleClientId || "";
        renderDemoLogins(config);
      } catch (error) {
        googleClientId = "";
      }
      showParentAuthMessage(parentEmailHint(), "ready");
      if (googleLoginButton) {
        googleLoginButton.disabled = false;
        googleLoginButton.title = googleClientId ? "Continue with Google" : "Set GOOGLE_CLIENT_ID to enable Google sign-in.";
      }
    }

    async function handleGoogleCredential(credential) {
      var response = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: credential, role: "parent" })
      });
      var payload = await response.json();
      if (!response.ok || !payload.token) throw new Error(payload.error || "Google sign-in failed");
      localStorage.setItem(PARENT_TOKEN_KEY, payload.token);
      if (payload.user) {
        if (form.elements.email) form.elements.email.value = payload.user.email || form.elements.email.value;
        if (form.elements.parentName) form.elements.parentName.value = payload.user.name || form.elements.parentName.value;
      }
      completionTitle.textContent = "Google sign-in connected";
      completionText.textContent = "Parent account is authenticated. Continue with subscription and child profile setup.";
      completionPanel.classList.add("is-active");
      validateParentEmail();
      preview();
      hideParentGate();
      syncSubscriptionFromEntitlement().catch(function () {});
    }

    function loadGoogleScript() {
      return new Promise(function (resolve, reject) {
        if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
        var existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
        if (existing) {
          existing.addEventListener("load", resolve, { once: true });
          existing.addEventListener("error", reject, { once: true });
          return;
        }
        var script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    async function startGoogleLogin() {
      if (!googleClientId) {
        if (parentLoginError) parentLoginError.textContent = "Google sign-in needs GOOGLE_CLIENT_ID in server config.";
        showParentAuthMessage("Google sign-in needs GOOGLE_CLIENT_ID in server config.", "error");
        return;
      }
      googleLoginButton.disabled = true;
      if (parentLoginError) parentLoginError.textContent = "Opening Google sign-in...";
      showParentAuthMessage("Opening Google sign-in...", "ready");
      try {
        await loadGoogleScript();
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: function (response) {
            handleGoogleCredential(response.credential).catch(function (error) {
              if (parentLoginError) parentLoginError.textContent = error.message || "Google sign-in failed.";
              showParentAuthMessage(error.message || "Google sign-in failed.", "error");
            }).finally(function () {
              googleLoginButton.disabled = false;
            });
          }
        });
        window.google.accounts.id.prompt(function () {
          googleLoginButton.disabled = false;
        });
      } catch (error) {
        googleLoginButton.disabled = false;
        if (parentLoginError) parentLoginError.textContent = "Google sign-in could not load. Try email and password.";
        showParentAuthMessage("Google sign-in could not load. Try email and password.", "error");
      }
    }

    function selectedPlan() {
      var pricing = readPricing();
      var key = selectedPlanKeyFromInputs(planInputs);
      var plan = pricing[key] || pricing.monthly;
      var planPromo = eligiblePromotion(key);
      var promoAmount = promotionAmountForPlan(planPromo, key);
      return {
        key: key,
        name: plan.label,
        price: formatPlanPrice(plan, promoAmount),
        stripePriceId: plan.stripePriceId,
        promoCode: planPromo ? planPromo.code : "",
        promoPrice: promoAmount || null
      };
    }

    function planByKey(key) {
      var pricing = readPricing();
      var plan = pricing[key] || pricing.monthly;
      return {
        key: key,
        name: plan.label,
        amount: plan.amount,
        interval: plan.interval,
        price: formatPlanPrice(plan, null),
        stripePriceId: plan.stripePriceId,
        promoCode: ""
      };
    }

    function yearlyUpgradeDetailText(info) {
      var accessMonths = Number(info?.accessMonths || 15);
      var bonus = Math.max(0, accessMonths - 12);
      var renewalDate = parentDateFromUnix(info?.yearlyNextRenewalAt);
      var bonusText = bonus > 0 ? " with " + bonus + " bonus month" + (bonus === 1 ? "" : "s") : "";
      return renewalDate
        ? "Yearly plan active" + bonusText + ". Renews " + renewalDate + "."
        : "Yearly plan active" + bonusText + ".";
    }

    function isYearlySubscription() {
      return activePlanKey === "yearly" || String(parentEntitlement?.plan || "").toLowerCase().indexOf("year") >= 0 || Boolean(yearlyUpgradeScheduled);
    }

    function activePlan() {
      return planByKey(activePlanKey);
    }

    // Show the trial promise only to someone who can still get one: no plan yet
    // and no prior payment. A reactivating or upgrading parent must not be told
    // they get another free week.
    function renderTrialPitch() {
      var pitch = document.getElementById("trial-pitch");
      if (!pitch) return;
      var trial = trialInfo();
      // Trust the server's eligibility rule (one trial per account, either kind)
      // rather than guessing client-side.
      pitch.hidden = trial ? !trial.eligible : paid;
    }

    function updatePlanTiles() {
      renderTrialPitch();
      var pricing = readPricing();
      planInputs.forEach(function (input) {
        var key = input.value;
        var plan = pricing[key] || pricing.monthly;
        var tile = input.closest(".plan-tile");
        var promo = eligiblePromotion(key);
        var promoAmount = promotionAmountForPlan(promo, key);
        tile.classList.toggle("is-selected", input.checked);
        tile.classList.toggle("has-promo", Boolean(promo));
        document.querySelector('[data-plan-name="' + key + '"]').textContent = planLabelForKey(key);
        document.querySelector('[data-plan-price="' + key + '"]').innerHTML = priceLabelMarkup(plan, promoAmount);
        document.querySelector('[data-plan-note="' + key + '"]').textContent = promo
          ? promo.code + ": " + (promo.description || "Limited-time promotion")
          : key === "yearly"
          ? "Best value for steady learning all year."
          : "Flexible family access, cancel any time.";
        // Meta rows mirror the yearly-upgrade tile so both plan surfaces read
        // the same way: an icon, a short fact, nothing longer.
        var metaEl = document.querySelector('[data-plan-meta="' + key + '"]');
        if (metaEl) {
          var seats = Number(plan.familyMemberCount || 3);
          var rows = key === "yearly"
            ? [["users-round", "Up to " + seats + " family members"], ["gift", "Two months free vs monthly"]]
            : [["users-round", "Up to " + seats + " family members"], ["refresh-cw", "Switch or cancel any time"]];
          metaEl.innerHTML = rows.map(function (row) {
            return "<span><i data-lucide='" + row[0] + "'></i><b>" + row[1] + "</b></span>";
          }).join("");
        }
      });
    }

    function setPlanChoice(key) {
      planInputs.forEach(function (input) {
        input.checked = input.value === key;
      });
      updatePlanTiles();
    }

      function applySignupPlanCards() {
        var pricingNow = readPricing();
        var monthlyPromo = eligiblePromotion('monthly');
        var yearlyPromo = eligiblePromotion('yearly');
        var monthlyBase = Number((pricingNow.monthly || {}).amount || 0);
        var yearlyBase = Number((pricingNow.yearly || {}).amount || 0);
        var monthlyNow = promotionAmountForPlan(monthlyPromo, 'monthly') || monthlyBase;
        var yearlyNow = promotionAmountForPlan(yearlyPromo, 'yearly') || yearlyBase;
        var seats = Number((pricingNow.monthly || {}).familyMemberCount || 3);
      
        var badge = currentPackageCard ? currentPackageCard.querySelector('.plan-badge') : null;
        if (badge) badge.textContent = 'Pay monthly';
        if (currentPackageName) currentPackageName.textContent = planLabelForKey('monthly');
        if (currentPackagePrice) currentPackagePrice.innerHTML = (monthlyNow < monthlyBase ? "<s>$" + monthlyBase + "</s> " : "") + "$" + monthlyNow;
        var monthlyInterval = document.getElementById('current-package-interval');
        if (monthlyInterval) monthlyInterval.textContent = '/ month';
        if (currentPackageNote) currentPackageNote.textContent = monthlyNow < monthlyBase
          ? (monthlyPromo && monthlyPromo.description) || 'Limited-time monthly price.'
          : 'Flexible family access. Cancel any time.';
        var factsEl = document.getElementById('current-package-facts');
        if (factsEl) {
          factsEl.innerHTML = [
            { icon: 'users-round', text: 'Up to ' + seats + ' family members' },
            { icon: 'puzzle', text: 'Chrome extension unlocked' },
            { icon: 'refresh-cw', text: 'Switch or cancel any time' }
          ].map(function (f) { return "<li><i data-lucide='" + f.icon + "'></i>" + text(f.text) + "</li>"; }).join('');
        }
        if (upgradeYearly) {
          upgradeYearly.classList.remove('hidden');
          upgradeYearly.innerHTML = "<i data-lucide='credit-card'></i>Continue with monthly";
        }
      
        if (upgradePlanKicker) upgradePlanKicker.textContent = yearlyNow < yearlyBase ? 'Limited-time offer' : 'Best value';
        if (upgradePlanTitle) upgradePlanTitle.textContent = 'Pay yearly';
        if (upgradeYearlyName) upgradeYearlyName.textContent = planLabelForKey('yearly');
        if (upgradeYearlyPrice) {
          upgradeYearlyPrice.innerHTML = (yearlyNow < yearlyBase ? "<s>$" + yearlyBase + "</s>" : "") +
            "<b>$" + yearlyNow + "</b><span>/year</span>";
        }
        if (upgradeYearlyPromo) {
          var code = yearlyPromo && yearlyPromo.code;
          upgradeYearlyPromo.textContent = code ? 'Code ' + code : 'Best value';
          upgradeYearlyPromo.classList.toggle('hidden', !code);
        }
        if (upgradeYearlyCopy) upgradeYearlyCopy.textContent = yearlyNow < yearlyBase
          ? (yearlyPromo && yearlyPromo.description) || 'Save on your first year.'
          : 'Best value for steady learning all year.';
        if (upgradeYearlyBonus) upgradeYearlyBonus.textContent = monthlyBase && yearlyNow
          ? 'Save $' + Math.max(0, Math.round(monthlyBase * 12 - yearlyNow)) + ' vs monthly'
          : 'Best value';
        if (upgradeYearlyBillingNote) upgradeYearlyBillingNote.textContent = 'Up to ' + seats + ' family members';
        if (upgradeYearlyTileButton) {
          upgradeYearlyTileButton.classList.remove('hidden');
          upgradeYearlyTileButton.innerHTML = "<i data-lucide='credit-card'></i>Continue with yearly";
        }
        renderIcons();
      }

    function renderSubscriptionState() {
      var plan = paid ? activePlan() : selectedPlan();
      if (subscriptionTitle) subscriptionTitle.textContent = (paid && !onNoCardTrial()) ? "Your current package" : "Choose a family plan";
      // A comped (no-card) trial is entitled but not subscribed: keep the plan
      // tiles and checkout button on screen. A paid monthly subscriber, including
      // a card-based trial, gets a dedicated yearly upgrade tile beside the
      // current package instead of the initial plan picker.
      // past_due is a billing problem, not a missing subscription: Stripe is still
      // retrying, so show billing actions rather than the signup plan picker.
      var pastDueNow = parentEntitlement && parentEntitlement.status === "past_due";
      var needsCheckout = (!paid || onNoCardTrial()) && !pastDueNow;
      // A monthly family that has cancelled but still has paid access left should
      // still see the yearly offer — that is the moment they are most likely to
      // reconsider, and upgrading clears the pending cancellation.
      var cancellingWithAccess = cancellationScheduled && cancellationAccessUntil &&
        new Date(cancellationAccessUntil).getTime() > Date.now();
      var showUpgradeTile = paid && !onNoCardTrial() && plan.key === "monthly" &&
        (!cancellationScheduled || cancellingWithAccess) && !yearlyUpgradeScheduled;
      // Both states use the SAME two-card layout: base plan in the white card on
      // the left, best-value plan in the green card on the right. For a signup the
      // left card is the Monthly option rather than a current package, so the two
      // screens no longer look like different products.
      if (currentPackageCard) currentPackageCard.classList.remove("hidden");
      if (planTileGrid) planTileGrid.classList.add("hidden");
      // Nothing to offer a yearly subscriber, so do not leave an empty "Choose
      // your plan" card sitting next to the current package.
      if (planSelectionSurface) planSelectionSurface.classList.toggle("hidden", !(needsCheckout || showUpgradeTile));
      if (upgradeYearlyContent) upgradeYearlyContent.classList.toggle("hidden", !(showUpgradeTile || needsCheckout));
      if (upgradePlanSurface) upgradePlanSurface.classList.toggle("is-upgrade-only", showUpgradeTile || needsCheckout);
      // The large right-hand tile is the single upgrade action for a current
      // monthly package; keep the legacy action in the current card hidden.
      if (upgradeYearly) upgradeYearly.classList.add("hidden");
      if (upgradeYearlyTileButton) upgradeYearlyTileButton.classList.toggle("hidden", !showUpgradeTile);
      if (upgradePlanTitle) upgradePlanTitle.textContent = showUpgradeTile ? "Upgrade to yearly" : "Choose your plan";
      if (upgradePlanKicker) {
        var upgradeKickerOffer = yearlyUpgradeOffer();
        upgradePlanKicker.textContent = showUpgradeTile && (upgradeKickerOffer.usesPlanPromotion || upgradeKickerOffer.usesUpgradeOffer) ? "Limited-time offer" : "Best value";
      }
      if (showUpgradeTile) {
        var tileOffer = yearlyUpgradeOffer();
        if (upgradeYearlyName) upgradeYearlyName.textContent = planLabelForKey("yearly");
        if (upgradeYearlyPrice) {
          upgradeYearlyPrice.innerHTML = (tileOffer.discountAmount > 0 ? "<s>$" + tileOffer.baseStr + "</s>" : "") +
            "<b>$" + tileOffer.priceStr + "</b><span>/year</span>";
        }
        if (upgradeYearlyPromo) {
          upgradeYearlyPromo.textContent = tileOffer.promoCode ? "Code " + tileOffer.promoCode : "Best value";
          upgradeYearlyPromo.classList.toggle("hidden", !tileOffer.promoCode);
        }
        if (upgradeYearlyCopy) upgradeYearlyCopy.textContent = onStripeTrial()
          ? ((tileOffer.usesPlanPromotion || tileOffer.usesUpgradeOffer) ? tileOffer.promoDescription || "Save on your first yearly charge." : "Keep your free trial, then switch to yearly billing when it ends.")
          : ((tileOffer.usesPlanPromotion || tileOffer.usesUpgradeOffer) ? tileOffer.promoDescription || "Save on your first yearly charge." : "Get a full year of access with your unused monthly time carried over.");
        // "+0 bonus months" reads as a downgrade. With no bonus configured, sell
        // the reason to upgrade instead: the money saved against paying monthly.
        if (upgradeYearlyBonus) {
          var bonusPill = onStripeTrial()
            ? { icon: "gift", text: "No charge today" }
            : tileOffer.bonusMonths > 0
            ? { icon: "gift", text: "+" + tileOffer.bonusMonths + " bonus month" + (tileOffer.bonusMonths === 1 ? "" : "s") }
            : tileOffer.annualSavings > 0
            ? { icon: "piggy-bank", text: "Save $" + moneyStr(tileOffer.annualSavings) + " a year" }
            : { icon: "calendar-check", text: "One payment, all year" };
          upgradeYearlyBonus.textContent = bonusPill.text;
          // lucide swaps <i data-lucide> for an <svg> on first render, so put a
          // fresh <i> back rather than trying to retarget the old element.
          var bonusHost = upgradeYearlyBonus.parentNode;
          var bonusIcon = bonusHost && bonusHost.firstElementChild;
          if (bonusHost && bonusIcon !== upgradeYearlyBonus) {
            var freshIcon = document.createElement("i");
            freshIcon.setAttribute("data-lucide", bonusPill.icon);
            if (bonusIcon) bonusHost.replaceChild(freshIcon, bonusIcon);
            else bonusHost.insertBefore(freshIcon, upgradeYearlyBonus);
          }
        }
        // "No double billing" answered a worry instead of giving a reason to
        // upgrade. Reassurance belongs in the fine print; this slot sells.
        if (upgradeYearlyBillingNote) {
          var billingPill = onStripeTrial()
            ? { icon: "shield-check", text: "Starts " + trialEndsText() }
            : tileOffer.freeMonths >= 1
            ? { icon: "sparkles", text: tileOffer.freeMonths + " months free vs monthly" }
            : { icon: "lock", text: "Price locked for 12 months" };
          upgradeYearlyBillingNote.textContent = billingPill.text;
          var billingHost = upgradeYearlyBillingNote.parentNode;
          var billingIcon = billingHost && billingHost.firstElementChild;
          if (billingHost && billingIcon !== upgradeYearlyBillingNote) {
            var freshBillingIcon = document.createElement("i");
            freshBillingIcon.setAttribute("data-lucide", billingPill.icon);
            if (billingIcon) billingHost.replaceChild(freshBillingIcon, billingIcon);
            else billingHost.insertBefore(freshBillingIcon, upgradeYearlyBillingNote);
          }
        }
        if (upgradeYearlyTileButton) upgradeYearlyTileButton.innerHTML = onStripeTrial()
          ? "Choose yearly billing<i data-lucide='arrow-up-right'></i>"
          : "Upgrade to yearly<i data-lucide='arrow-up-right'></i>";
        renderIcons();
      }
      renderPromotionOffer();
      if (subscriptionFineprint) subscriptionFineprint.classList.toggle("hidden", !(paid || pastDueNow));
      if (cancelSubscription) cancelSubscription.classList.toggle("hidden", !paid);
      // One-click undo while the paid period is still running — the cheapest
      // revenue there is, and the moment a parent is most likely to reconsider.
      if (resumeSubscription) {
        var canResume = paid && cancellationScheduled && cancellationAccessUntil &&
          new Date(cancellationAccessUntil).getTime() > Date.now();
        resumeSubscription.hidden = !canResume;
      }
      if (currentPackageName) currentPackageName.textContent = plan.name;
      if (currentPackagePrice) currentPackagePrice.textContent = "$" + (plan.amount || "—");
      var currentPackageInterval = document.getElementById("current-package-interval");
      // Pricing stores "mo"/"yr", so an exact "year" match always fell through to
      // "month" — a yearly plan rendered as "$149 / month".
      if (currentPackageInterval) currentPackageInterval.textContent = "/ " + (String(plan.interval || "").charAt(0) === "y" ? "year" : "month");
      if (currentPackageCard) currentPackageCard.classList.toggle("is-yearly", plan.key !== "monthly");
      renderCurrentPackageFacts(plan);
      if (currentPackageNote) {
        currentPackageNote.textContent = onStripeTrial()
          ? (cancellationScheduled
            ? "Current plan cancels on " + parentDate(cancellationAccessUntil || trialEndsText()) + ". Access continues until then, and you will not be charged."
            : "Your child has access during the trial. Billing starts on " + trialEndsText() + " unless cancelled.")
          : yearlyUpgradeScheduled
          ? yearlyUpgradeDetailText(yearlyUpgradeInfo)
          : cancellationScheduled
          ? "Cancellation scheduled: your child keeps extension access until " + parentDate(cancellationAccessUntil) + "."
          : retentionOfferAccepted
          ? "$" + cancellationPromoConfig().amountOff + " off will apply automatically to the next invoice."
          // The upgrade pitch lives on the yearly tile now; repeating it on the
          // current-plan card sold the same thing twice.
          : plan.key === "monthly"
          ? ""
          : "Your yearly package is active. Child profiles and extension access stay unlocked.";
        // An empty <p> still occupies its margins, leaving a gap above the pill.
        currentPackageNote.hidden = !currentPackageNote.textContent;
      }
      if (upgradeYearly) {
        upgradeYearly.classList.add("hidden");
        upgradeYearly.textContent = "Upgrade to yearly";
        renderUpgradeOffer();
      }
      renderRailPromo();
      if (paid) {
        var chipTrialing = onStripeTrial();
        paymentState.textContent = chipTrialing
          ? (cancellationScheduled ? "Trial ends " + parentDate(cancellationAccessUntil || trialEndsText()) : "Free trial · ends " + trialEndsText())
          : yearlyUpgradeScheduled
          ? "Yearly upgrade confirmed"
          : cancellationScheduled
          ? "Cancels " + parentDate(cancellationAccessUntil)
          : retentionOfferAccepted
          ? "$" + cancellationPromoConfig().amountOff + " off next invoice"
          : plan.name + " active";
        // "trialing" shares the green active treatment — a trial is an entitled
        // state, and the label carries the distinction.
        paymentState.className = "state-chip " + (chipTrialing ? "trialing" : "ok");
      }
      // Last, so the generic current-package rendering above cannot overwrite the
      // signup content.
      if (needsCheckout) applySignupPlanCards();
      else {
        // Restore the subscriber wording: the signup pass may have run first while
        // the entitlement was still loading, and it rewrites this badge.
        var pkgBadge = currentPackageCard ? currentPackageCard.querySelector(".plan-badge") : null;
        if (pkgBadge) pkgBadge.textContent = "Current package";
      }
    }

    // Card-upfront Stripe trial state, straight from /api/entitlements/me.
    function trialInfo() {
      return (parentEntitlement && parentEntitlement.trial) || null;
    }

    // Admin-granted trial: entitled, but no card and no Stripe subscription — the
    // parent still has to subscribe, so checkout must stay reachable.
    function onNoCardTrial() {
      var trial = trialInfo();
      return Boolean(trial && trial.status === "trial" && !trial.cardOnFile);
    }

    function onStripeTrial() {
      var trial = trialInfo();
      return Boolean(trial && trial.status === "trialing");
    }

    function trialEndsText() {
      var trial = trialInfo();
      return trial && trial.endsAt ? parentDate(trial.endsAt) : "";
    }

    function cancellationPromoConfig() {
      var pricing = readPricing();
      var promo = pricing.cancellationPromo || {};
      return {
        enabled: promo.enabled !== false && Number(promo.amountOff || 0) > 0,
        amountOff: Math.max(0, Number(promo.amountOff || 0)),
        duration: promo.duration === "repeating" ? "repeating" : "once",
        description: String(promo.description || "Keep your plan and get a discount on the next renewal.")
      };
    }

    // Refunding a yearly UPGRADE reverts to the monthly plan and keeps access to
    // the end of the month already paid for — so the refund copy must not promise
    // that access ends straight away.
    function upgradeRefundKeepsMonthly() {
      var up = parentEntitlement && parentEntitlement.yearlyUpgrade;
      if (!up || up.status !== "scheduled" || !up.monthlyEndsAt) return null;
      var raw = up.monthlyEndsAt;
      var at = typeof raw === "number" ? raw * 1000 : new Date(raw).getTime();
      if (!isFinite(at) || at <= Date.now()) return null;
      return new Date(at).toISOString();
    }

    function refundWindow() {
      return (parentEntitlement && parentEntitlement.refundWindow) || null;
    }

    function inRefundWindow() {
      var w = refundWindow();
      return Boolean(w && w.eligible);
    }

    function prepareCancellationFlow() {
      var yearly = isYearlySubscription();
      var rw = refundWindow();
      var refundable = inRefundWindow();
      var trialing = onStripeTrial();
      var promo = cancellationPromoConfig();
      var promoAvailable = promo.enabled && promo.amountOff > 0 && !yearly && !refundable;
      if (cancellationYearlyOption) cancellationYearlyOption.classList.toggle("hidden", yearly || refundable);
      if (trialing) {
        if (cancelFlowLabel) cancelFlowLabel.textContent = "Trial";
        if (cancelFlowTitle) cancelFlowTitle.textContent = promoAvailable ? "$" + promo.amountOff + " off your first renewal" : "End your free trial";
        if (cancelFlowCopy) {
          cancelFlowCopy.textContent = promoAvailable
            ? "Your current plan cancels on " + trialEndsText() + " if you continue. Keep it instead and get $" + promo.amountOff + " off when billing starts on " + trialEndsText() + ". No code is needed."
            : "Your trial ends on " + trialEndsText() + " and you will not be charged. Your child keeps access until then, and all profiles and progress are saved.";
        }
        if (acceptDiscount) {
          acceptDiscount.classList.toggle("hidden", !promoAvailable);
          acceptDiscount.textContent = promoAvailable ? "Keep plan with $" + promo.amountOff + " off" : "Keep my plan";
        }
        if (confirmCancel) confirmCancel.textContent = "Cancel renewal";
        if (saveOffer) saveOffer.classList.toggle("yearly-cancel", !promoAvailable);
        return;
      }
      // "Save offer" only makes sense when there is an offer — with the promo
      // switched off in admin the monthly flow is a plain cancellation.
      if (cancelFlowLabel) cancelFlowLabel.textContent = (refundable && upgradeRefundKeepsMonthly()) ? "Upgrade refund" : refundable ? "Full refund" : yearly ? "Renewal cancellation" : promoAvailable ? "Save offer" : "Renewal cancellation";
      if (cancelFlowTitle) {
        cancelFlowTitle.textContent = (refundable && upgradeRefundKeepsMonthly()) ? "Refund your yearly upgrade"
          : refundable
          ? "Cancel and get a full refund"
          : yearly ? "Cancel yearly renewal" : promoAvailable ? "$" + promo.amountOff + " off your next renewal" : "Cancel your renewal";
      }
      if (cancelFlowCopy) {
        // Inside the refund window cancelling refunds the payment in full and
        // ends access immediately — say so before they confirm, not after.
        var keepsMonthlyUntil = refundable ? upgradeRefundKeepsMonthly() : null;
        cancelFlowCopy.textContent = keepsMonthlyUntil
          ? "You are still within " + rw.windowDays + " days of the upgrade, so we refund it in full. You go back to your monthly plan, which you have already paid for — your child keeps access until " + parentDate(keepsMonthlyUntil) + ", then it ends."
          : refundable
          ? "You are still within " + rw.windowDays + " days of your payment, so cancelling now refunds it in full. Extension access ends straight away and your child's profiles and progress are kept."
          : yearly
          ? "We will turn off auto-renewal. Your child keeps access through the end of the paid yearly plan. This payment is not refundable."
          : promoAvailable
          ? promo.description + " It will be applied automatically to the next invoice."
          : "Your renewal will be turned off. Your child keeps access through the paid plan end date.";
      }
      if (acceptDiscount) {
        acceptDiscount.classList.toggle("hidden", !promoAvailable);
        acceptDiscount.textContent = promoAvailable ? "Keep plan with $" + promo.amountOff + " off" : "Keep my plan";
      }
      // Inside the window the plan itself ends (refunded); outside, only the
      // renewal stops and access runs to the period end.
      if (confirmCancel) confirmCancel.textContent = (refundable && upgradeRefundKeepsMonthly()) ? "Refund upgrade"
        : refundable ? "Cancel plan" : "Cancel renewal";
      if (saveOffer) saveOffer.classList.toggle("yearly-cancel", yearly || refundable);
    }

    function setPaidPlan(key, title, detail) {
      paid = true;
      activePlanKey = key || activePlanKey || "monthly";
      localStorage.setItem(ACTIVE_PLAN_KEY, activePlanKey);
      localStorage.removeItem(PENDING_CHECKOUT_PLAN_KEY);
      setPlanChoice(activePlanKey);
      completionTitle.textContent = title || "Subscription active";
      completionText.textContent = detail || activePlan().name + " is active. Child profiles and extension access are unlocked.";
      completionPanel.classList.add("is-active");
      preview();
      // Entitlement resolves after the first paint, so the subscription card has
      // to re-render here — otherwise it keeps whatever state it guessed at load.
      renderSubscriptionState();
    }

    function setUnpaidSubscription(title, detail, stateText) {
      paid = false;
      retentionOfferAccepted = false;
      yearlyUpgradeScheduled = false;
      yearlyUpgradeInfo = null;
      cancellationScheduled = false;
      cancellationAccessUntil = "";
      localStorage.removeItem(ACTIVE_PLAN_KEY);
      if (paymentState) {
        paymentState.textContent = stateText || "Payment pending";
        paymentState.className = "state-chip warning";
      }
      if (completionTitle) completionTitle.textContent = title || "Choose a family plan";
      if (completionText) completionText.textContent = detail || "Select monthly or yearly, then complete Stripe checkout to unlock extension access.";
      if (completionPanel) completionPanel.classList.remove("is-active");
      preview();
      // Entitlement resolves after the first paint, so the subscription card has
      // to re-render here — otherwise it keeps whatever state it guessed at load.
      renderSubscriptionState();
    }

    async function syncSubscriptionFromEntitlement() {
      if (!parentToken()) return false;
      try {
        var response = await parentAuthFetch("/api/entitlements/me");
        var entitlement = await response.json();
        if (!response.ok) throw entitlement;
        parentEntitlement = entitlement;
        parentRenewalAt = entitlement.renewalAt || (entitlement.trial && entitlement.trial.endsAt) || "";
        if (entitlement.active) {
          var key = String(entitlement.plan || "").toLowerCase().indexOf("year") >= 0 ? "yearly" : "monthly";
          cancellationScheduled = entitlement.status === "cancel_scheduled";
          cancellationAccessUntil = entitlement.cancelAccessUntil || "";
          yearlyUpgradeInfo = entitlement.yearlyUpgrade || null;
          yearlyUpgradeScheduled = Boolean(yearlyUpgradeInfo && yearlyUpgradeInfo.status === "scheduled");
          var trialing = onStripeTrial();
          var compedTrial = onNoCardTrial();
          var trialEnds = trialEndsText();
          var planName = entitlement.plan || activePlan().name;
          // During a trial the parent needs the end date and when billing starts
          // — a bare "Subscription active" hides the fact a charge is coming.
          var title = cancellationScheduled
            ? (trialing ? "Trial ending" : "Cancellation scheduled")
            : compedTrial ? "Free trial active"
            : trialing ? "Free trial active"
            : yearlyUpgradeScheduled ? "Yearly upgrade confirmed"
            : "Subscription active";
          var detail;
          if (cancellationScheduled && trialing) {
            detail = "Current plan cancels on " + parentDate(cancellationAccessUntil || trialEnds) + ". Access continues until then, and you will not be charged.";
          } else if (cancellationScheduled) {
            detail = "Your subscription is scheduled to cancel on " + parentDate(cancellationAccessUntil) + ". Your child can keep using the extension until then.";
          } else if (compedTrial) {
            // No card on file: nothing will be charged, so they must choose a
            // plan to keep access when the trial ends.
            detail = "Your child has full access until " + trialEnds + ". Choose a plan below to keep it going — you can subscribe any time during or after the trial.";
          } else if (trialing) {
            detail = planName + " · your child has access during the trial. Billing starts on " + trialEnds + " unless cancelled.";
          } else if (yearlyUpgradeScheduled) {
            detail = yearlyUpgradeDetailText(yearlyUpgradeInfo);
          } else {
            detail = planName + " is active for this family.";
          }
          setPaidPlan(key, title, detail);
          if (compedTrial && paymentState) {
            paymentState.textContent = "Free trial · ends " + trialEnds;
            paymentState.className = "state-chip trialing";
          }
          if (trialing && paymentState) {
            paymentState.textContent = cancellationScheduled ? "Cancels " + parentDate(cancellationAccessUntil || trialEnds) : "Trial ends " + trialEnds;
            paymentState.className = "state-chip warning";
          }
        } else {
          var pastDue = entitlement.status === "past_due";
          setUnpaidSubscription(
            pastDue ? "Payment failed"
              : entitlement.reason === "locked" ? "Account locked" : "Choose a family plan",
            pastDue
              ? "Your last payment did not go through, so tools are paused. Update your billing card and access returns as soon as it clears — no need to sign up again."
              : entitlement.reason === "locked"
              ? "This account is locked. Contact KiddieGPT support to restore access."
              : "This parent account does not have an active package yet. Choose monthly or yearly to unlock the extension.",
            pastDue ? "Payment failed" : entitlement.reason === "locked" ? "Account locked" : "Payment pending"
          );
        }
        return true;
      } catch (error) {
        parentEntitlement = null;
        setUnpaidSubscription("Check subscription", error.error || "Could not verify subscription status. Try signing in again.", "Needs attention");
        return false;
      }
    }

    async function syncSubscriptionFromReturnUrl() {
      var params = new URLSearchParams(window.location.search);
      if (params.get("cancel") === "1" || params.get("stripe") === "cancelled") {
        localStorage.removeItem(PENDING_CHECKOUT_PLAN_KEY);
        completionTitle.textContent = paid ? "Subscription active" : "Checkout cancelled";
        completionText.textContent = paid ? activePlan().name + " remains active." : "Checkout was cancelled. Your package was not changed.";
        return false;
      }
      var returnedFromStripe = params.get("paid") === "1" || params.get("stripe") === "success" || params.has("session_id");
      if (!returnedFromStripe) return false;
      setPaidPlan(localStorage.getItem(PENDING_CHECKOUT_PLAN_KEY) || activePlanKey || "monthly", "Payment complete", "Your package is active. Review child profiles, learning goals, and rewards, then save the family profile.");
      var sessionId = params.get("session_id");
      if (sessionId) {
        try {
          var response = await fetch("/api/stripe/confirm-checkout-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId })
          });
          var result = await response.json();
          if (response.ok && result.active) {
            var key = String(result.plan || "").toLowerCase().indexOf("year") >= 0 ? "yearly" : "monthly";
            setPaidPlan(key, "Subscription active", (result.plan || activePlan().name) + " is active for this family.");
          }
        } catch (error) {
          completionText.textContent = "Payment returned from Stripe. Entitlement will refresh after Stripe confirms the session.";
        }
      }
      return true;
    }

    function syncSubscriptionFromBackend() {
      var email = formValue("email").trim().toLowerCase();
      if (!email) return false;
      var family = readFamilies().find(function (item) {
        return String(item.email || "").toLowerCase() === email &&
          (item.subscriptionStatus === "active" || item.subscriptionStatus === "cancel_scheduled") &&
          item.paymentStatus !== "failed";
      });
      if (!family) return false;
      var key = String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "yearly" : "monthly";
      retentionOfferAccepted = family.retentionOffer && family.retentionOffer.status === "accepted";
      yearlyUpgradeInfo = family.yearlyUpgrade || null;
      yearlyUpgradeScheduled = yearlyUpgradeInfo && yearlyUpgradeInfo.status === "scheduled";
      cancellationScheduled = family.subscriptionStatus === "cancel_scheduled";
      cancellationAccessUntil = family.cancelAccessUntil || family.cancellationAccessUntil || "";
      setPaidPlan(
        key,
        cancellationScheduled ? "Cancellation scheduled" : yearlyUpgradeScheduled ? "Yearly upgrade confirmed" : "Subscription active",
        cancellationScheduled
          ? "Your subscription is scheduled to cancel on " + parentDate(cancellationAccessUntil) + ". Your child can keep using the extension until then."
          : yearlyUpgradeScheduled
          ? yearlyUpgradeDetailText(yearlyUpgradeInfo)
          : family.plan + " is active for this family."
      );
      return true;
    }

    function daysSinceIso(value) {
      if (!value) return 0;
      var time = new Date(value).getTime();
      if (!Number.isFinite(time)) return 0;
      return Math.max(0, Math.floor((Date.now() - time) / 86400000));
    }

    function currentParentFamily() {
      var email = normalizeEmail(signedInParentEmail || formValue("email"));
      if (!email) return null;
      if (parentEntitlement) {
        return {
          email: email,
          createdAt: parentEntitlement.createdAt,
          subscriptionStatus: parentEntitlement.status,
          paymentStatus: parentEntitlement.paymentStatus,
          accountLocked: parentEntitlement.locked,
          plan: parentEntitlement.plan,
          cancellationStatus: parentEntitlement.cancellationStatus,
          cancelAccessUntil: parentEntitlement.cancelAccessUntil,
          cancelReason: parentEntitlement.cancelReason
        };
      }
      return readFamilies().find(function (family) {
        return normalizeEmail(family.email) === email;
      }) || null;
    }

    function configuredPromotionForPlan(planKey) {
      var pricing = readPricing();
      var promo = pricing.promotion || {};
      var key = planKey || selectedPlanKeyFromInputs(planInputs);
      var code = String((key === "yearly" ? promo.yearlyCode : promo.monthlyCode) || promo.code || "").trim();
      if (promo.enabled === false || !code) return null;
      var amount = promotionAmountForPlan(promo, key);
      var base = Number((pricing[key] || {}).amount || 0);
      if (!amount || !base || amount >= base) return null;
      // promo goes first: spreading it last overwrote the per-plan code and the
      // requested planKey with the stored record's own values.
      return Object.assign({}, promo, {
        code: code,
        planKey: key,
        promoPrice: amount
      });
    }

    function eligiblePromotion(planKey) {
      if (paid) return null;
      return configuredPromotionForPlan(planKey);
    }

    function renderPromotionOffer() {
      activePromo = eligiblePromotion();
      if (promoRow) promoRow.classList.add("hidden");
      if (promoState) promoState.classList.add("hidden");
      updatePlanTiles();
    }

    function readingLevelLabel(value) {
      return { "1": "Emerging", "2": "On track", "3": "Advanced" }[String(value)] || "On track";
    }

    function readingLevelValue(label) {
      return { "Emerging": "1", "On track": "2", "Advanced": "3" }[String(label)] || "2";
    }

    function gradeNumber(value) {
      var match = String(value == null ? "" : value).match(/\d+/);
      if (!match) return "";
      return String(Math.min(12, Math.max(1, Number(match[0]))));
    }

    function gradeLabel(value) {
      var number = gradeNumber(value);
      return number ? "Grade " + number : "";
    }

    function fillGoalRow(row, goal) {
      var g = row.querySelector('[name="goal"]'); if (g) g.value = goal.goal || "";
      var r = row.querySelector('[name="reward"]'); if (r) r.value = goal.reward || "";
      var c = row.querySelector('[name="goalComplete"]'); if (c) c.checked = Boolean(goal.completed);
    }

    function studentSlides() {
      return Array.from(document.querySelectorAll(".student-workspace-slide"));
    }

    function activeStudentSlide() {
      var slides = studentSlides();
      return slides[activeChildIndex] || slides[0] || null;
    }

    function activeProgressChild(children) {
      var profiles = Array.from(document.querySelectorAll(".child-profile"));
      var profile = profiles[activeChildIndex];
      var id = profile && profile.dataset.childId;
      if (id) {
        var matched = (children || []).find(function (child) { return String(child.id || "") === String(id); });
        if (matched) return matched;
      }
      return (children || [])[activeChildIndex] || null;
    }

    function removeCloneIds(slide) {
      slide.querySelectorAll("[id]").forEach(function (el) { el.removeAttribute("id"); });
    }

    // Rebuild the child-profile cards from the family's saved children so the
    // parent sees ALL their students (not just the default first profile).
    function hydrateChildren(family) {
      if (!family) return;
      // The parent's name/email are authoritative on the family record; the auth
      // token may not carry them. Populate the (required) fields so a later save
      // isn't silently blocked by an empty parentName the parent never sees.
      if (family.parentName && form.elements.parentName && !form.elements.parentName.value.trim()) {
        form.elements.parentName.value = family.parentName;
      }
      if (family.email && form.elements.email && !form.elements.email.value.trim()) {
        form.elements.email.value = family.email;
      }
      if (!Array.isArray(family.children) || !family.children.length) return;
      var baseSlide = studentSlides()[0];
      if (!baseSlide) return;
      studentSlides().slice(1).forEach(function (slide) { slide.remove(); });
      activeChildIndex = 0;
      family.children.slice(0, 3).forEach(function (child, index) {
        var slide = index === 0 ? baseSlide : baseSlide.cloneNode(true);
        if (index > 0) {
          removeCloneIds(slide);
          childList.appendChild(slide);
        }
        slide.dataset.slideIndex = String(index);
        var node = slide.querySelector(".child-profile");
        if (child.id) node.dataset.childId = child.id;
        node.dataset.readingLevel = child.readingLevel || "";
        var heading = node.querySelector("h3"); if (heading) heading.textContent = "Child " + (index + 1);
        var nameEl = node.querySelector('[name="studentName"]'); if (nameEl) nameEl.value = child.studentName || "";
        var gradeEl = node.querySelector('[name="grade"]'); if (gradeEl) gradeEl.value = gradeNumber(child.grade) || "5";
        var goals = (child.learningGoals && child.learningGoals.length)
          ? child.learningGoals.slice(0, 7)
          : (child.goal ? [{ goal: child.goal, reward: child.reward, completed: false }] : []);
        var list = node.querySelector(".goal-reward-list");
        if (list) list.innerHTML = "";
        var firstRow = createGoalRow();
        if (list) list.appendChild(firstRow);
        if (goals.length && firstRow) {
          fillGoalRow(firstRow, goals[0]);
          goals.slice(1).forEach(function (goal) {
            var row = createGoalRow();
            fillGoalRow(row, goal);
            if (list) list.appendChild(row);
          });
        }
        var progressList = slide.querySelector(".progress-list");
        if (progressList) progressList.innerHTML = '<div class="progress-empty">Your child\'s activity from the KiddieGPT extension will show here.</div>';
        updateGoalRows(node);
      });
      updateChildCards();
      renderIcons();
      preview();
    }

    async function loadParentFamily() {
      try {
        var res = await parentAuthFetch("/api/auth/me");
        var data = await res.json();
        if (res.ok && data.family) hydrateChildren(data.family);
      } catch (error) { /* ignore */ }
    }

    function updateGoalRows(profile) {
      var rows = Array.from(profile.querySelectorAll(".goal-reward-row"));
      var list = profile.querySelector(".goal-reward-list");
      var orderedRows = rows.slice().sort(function (a, b) {
        return Number(a.querySelector('[name="goalComplete"]').checked) - Number(b.querySelector('[name="goalComplete"]').checked);
      });
      // Avoid re-appending the active input row on every keystroke. Moving a
      // focused input in the DOM interrupts typing and can make the field
      // appear unresponsive to the parent.
      orderedRows.forEach(function (row, index) {
        if (list.children[index] !== row) list.appendChild(row);
      });
      var showCompleted = profile.querySelector(".show-completed").checked;
      rows.forEach(function (row) {
        var checked = row.querySelector('[name="goalComplete"]').checked;
        row.classList.toggle("is-complete", checked);
        row.classList.toggle("is-hidden-complete", checked && !showCompleted);
        row.hidden = checked && !showCompleted;
        row.querySelector(".delete-goal").classList.toggle("hidden", rows.length === 1);
      });
      var addGoal = profile.querySelector(".add-goal");
      if (addGoal) {
        var atLimit = rows.length >= 7;
        addGoal.disabled = atLimit;
        addGoal.title = atLimit ? "Maximum of 7 goals and rewards" : "Add goal and reward";
      }
    }

    function createGoalRow(goal) {
      var row = document.createElement("div");
      row.className = "goal-reward-row";
      row.innerHTML =
        '<label class="complete-check"><input type="checkbox" name="goalComplete"><span>Done</span></label>' +
        '<label>Learning goal<input type="text" name="goal" maxlength="75" placeholder="Example: Reading confidence"></label>' +
        '<label>Reward<input type="text" name="reward" maxlength="75" placeholder="Example: Movie night"></label>' +
        '<button class="ghost-icon delete-goal" type="button" aria-label="Delete goal"><i data-lucide="trash-2"></i></button>';
      if (goal) {
        row.querySelector('[name="goalComplete"]').checked = Boolean(goal.completed);
        row.querySelector('[name="goal"]').value = goal.goal || "";
        row.querySelector('[name="reward"]').value = goal.reward || "";
      }
      return row;
    }

    function profileGoals(profile) {
      return Array.from(profile.querySelectorAll(".goal-reward-row")).map(function (row) {
        var goal = row.querySelector('[name="goal"]').value.trim();
        var reward = row.querySelector('[name="reward"]').value.trim();
        var completed = row.querySelector('[name="goalComplete"]').checked;
        return { goal: goal, reward: reward, completed: completed };
      }).filter(function (item) {
        return item.goal || item.reward;
      });
    }

    function childProfiles() {
      return Array.from(document.querySelectorAll(".child-profile")).map(function (profile, index) {
        var name = profile.querySelector('[name="studentName"]').value.trim();
        var grade = profile.querySelector('[name="grade"]').value;
        var readingLevel = profile.dataset.readingLevel || "";
        var goals = profileGoals(profile);
        var firstGoal = goals.find(function (item) { return !item.completed; }) || goals[0] || { goal: "", reward: "" };
        // Each card carries a stable id so a re-save keeps the same child id and
        // its already-synced progress/usage stays attached. New cards mint one
        // once and remember it here.
        var stableId = profile.dataset.childId;
        if (!stableId) { stableId = "child_" + makeId(); profile.dataset.childId = stableId; }
        return {
          id: stableId,
          studentName: name,
          grade: gradeLabel(grade),
          readingLevel: readingLevel,
          learningGoals: goals,
          goal: firstGoal.goal,
          reward: firstGoal.reward
        };
      }).filter(function (child) {
        return child.studentName || child.grade || child.goal || child.reward || child.learningGoals.length;
      });
    }

    function applyDemo(name) {
      var demo = demos[name];
      if (!demo) return;
      if (name === "parent") {
        ["parentName", "email", "password"].forEach(function (field) {
          if (form.elements[field]) {
            form.elements[field].value = demo[field];
          }
        });
      }

      var firstChild = document.querySelector(".child-profile");
      if (firstChild) {
        firstChild.querySelector('[name="studentName"]').value = demo.studentName;
        firstChild.querySelector('[name="grade"]').value = gradeNumber(demo.grade) || "5";
        var list = firstChild.querySelector(".goal-reward-list");
        list.innerHTML = "";
        demo.goals.forEach(function (goal) {
          list.appendChild(createGoalRow(goal));
        });
        updateGoalRows(firstChild);
      }

      setParentTab("overview");
      completionTitle.textContent = name === "student" ? "Student demo loaded" : "Parent demo loaded";
      completionText.textContent = "Review the details, complete payment, then save this family profile.";
      preview();
    }

    function updateChildCards() {
      var profiles = Array.from(document.querySelectorAll(".child-profile"));
      var slides = studentSlides();
      activeChildIndex = Math.max(0, Math.min(activeChildIndex, Math.max(0, profiles.length - 1)));
      profiles.forEach(function (profile, index) {
        var slide = slides[index];
        var nameInput = profile.querySelector('[name="studentName"]');
        var avatar = profile.querySelector(".avatar");
        var remove = profile.querySelector(".remove-child");
        var name = nameInput.value.trim();
        avatar.textContent = (name || "C").charAt(0).toUpperCase();
        profile.dataset.childIndex = String(index);
        profile.classList.toggle("is-active-profile", index === activeChildIndex);
        profile.hidden = false;
        if (slide) {
          slide.dataset.slideIndex = String(index);
          slide.hidden = index !== activeChildIndex;
        }
        remove.classList.toggle("hidden", profiles.length === 1);
        updateGoalRows(profile);
      });
      var studentCount = document.querySelector("[data-student-count]");
      if (studentCount) studentCount.textContent = profiles.length + " active " + (profiles.length === 1 ? "profile" : "profiles");
      if (childPosition) childPosition.textContent = (profiles.length ? activeChildIndex + 1 : 0) + " of 3";
      if (previousChild) previousChild.disabled = profiles.length < 2 || activeChildIndex === 0;
      if (nextChild) nextChild.disabled = profiles.length < 2 || activeChildIndex >= profiles.length - 1;
      if (addChild) {
        addChild.disabled = profiles.length >= 3;
        addChild.title = profiles.length >= 3 ? "Maximum of 3 child profiles" : "Add child profile";
      }
      renderLiveProfile();
      if (lastProgressData) renderProgress(lastProgressData);
    }

    function renderLiveProfile() {
      var profiles = Array.from(document.querySelectorAll(".child-profile"));
      var profile = profiles[activeChildIndex] || profiles[0];
      if (!profile) return;
      var slide = activeStudentSlide();
      var name = (profile.querySelector('[name="studentName"]') || {}).value || "Child";
      var grade = gradeLabel((profile.querySelector('[name="grade"]') || {}).value) || "Grade not set";
      var level = readingLevelLabel(profile.dataset.readingLevel || "");
      var goals = profileGoals(profile);
      var completed = goals.filter(function (goal) { return goal.completed; }).length;
      var reward = goals.find(function (goal) { return goal.reward; });
      var initials = name.trim().split(/\s+/).map(function (part) { return part.charAt(0); }).join("").slice(0, 2).toUpperCase() || "C";
      var summaryInitials = slide ? slide.querySelector("#live-profile-initials") : null;
      var summaryName = slide ? slide.querySelector("#live-profile-name") : null;
      var summaryDetails = slide ? slide.querySelector("#live-profile-details") : null;
      var summaryStatus = slide ? slide.querySelector("#live-profile-status") : null;
      var summaryGoalCount = slide ? slide.querySelector("#live-profile-goal-count") : null;
      var summaryGoals = slide ? slide.querySelector("#live-profile-goals") : null;
      var summaryReward = slide ? slide.querySelector("#live-profile-reward") : null;
      var summaryRewardProgress = slide ? slide.querySelector("#live-profile-reward-progress") : null;
      if (summaryInitials) summaryInitials.textContent = initials;
      if (summaryName) summaryName.textContent = name.trim() || "Add a student";
      if (summaryDetails) summaryDetails.innerHTML = text(grade) + " <b>•</b> " + text(level);
      if (summaryStatus) summaryStatus.textContent = name.trim() ? "On track" : "Needs setup";
      if (summaryGoalCount) summaryGoalCount.textContent = goals.length + " " + (goals.length === 1 ? "goal" : "goals");
      if (summaryReward) summaryReward.textContent = reward ? reward.reward : "Add a reward";
      if (summaryRewardProgress) summaryRewardProgress.textContent = goals.length ? completed + " of " + goals.length + " goals" : "Optional";
      if (summaryGoals) {
        summaryGoals.innerHTML = goals.length ? goals.slice(0, 4).map(function (goal, index) {
          return '<div class="goal-row"><span class="goal-check ' + (goal.completed ? 'is-done' : '') + '"><i data-lucide="' + (goal.completed ? 'check' : index ? 'book-open' : 'message-circle') + '"></i></span><span class="goal-copy"><strong>' + text(goal.goal || "Learning goal") + '</strong><small>' + (goal.completed ? 'Completed' : 'In progress') + '</small></span><span class="goal-state ' + (goal.completed ? 'done' : '') + '">' + (goal.completed ? 'Done' : 'Next') + '</span></div>';
        }).join("") : '<div class="goal-row"><span class="goal-check"><i data-lucide="book-open"></i></span><span class="goal-copy"><strong>Add a learning goal</strong><small>Use Edit profile to get started</small></span><span class="goal-state">Next</span></div>';
      }
      var supportName = document.getElementById("support-account-name");
      var supportEmail = document.getElementById("support-account-email");
      var supportInitials = document.getElementById("support-account-initials");
      var parentName = (formValue("parentName") || "Parent").trim();
      var email = formValue("email") || "";
      if (supportName) supportName.textContent = parentName;
      if (supportEmail) supportEmail.textContent = email;
      if (supportInitials) supportInitials.textContent = parentName.split(/\s+/).map(function (part) { return part.charAt(0); }).join("").slice(0, 2).toUpperCase() || "P";
      renderIcons();
    }

    function preview() {
      var capValue = formValue("usageCap") || "60";
      var children = childProfiles();
      var capPreview = document.getElementById("preview-cap");
      if (capPreview) capPreview.textContent = capValue + " min";
      if (parentAccountName) parentAccountName.textContent = formValue("parentName").trim() || "Parent";
      if (parentAccountPlan) parentAccountPlan.textContent = paid ? activePlan().name : "Setup in progress";
      if (parentSideStatus) {
        parentSideStatus.lastChild.textContent = paid ? (cancellationScheduled ? "Ending" : onStripeTrial() ? "Trial" : "Active") : "Pending";
        parentSideStatus.classList.toggle("is-pending", !paid || cancellationScheduled);
      }
      if (parentSideNote) {
        parentSideNote.textContent = cancellationScheduled
          ? "Access remains active until " + parentDate(cancellationAccessUntil)
          : onStripeTrial()
          ? "Billing starts " + trialEndsText()
          : paid ? "Family access and extension sync" : "Choose a plan to unlock access";
      }
      renderLiveProfile();
      var sidePlan = paid ? activePlan() : selectedPlan();
      var sidePrice = document.getElementById("parent-side-price");
      var sideInterval = document.getElementById("parent-side-interval");
      if (sidePrice) sidePrice.textContent = paid ? "$" + (sidePlan.amount || "—") : sidePlan.price;
      if (sideInterval) sideInterval.textContent = paid ? "/ " + (sidePlan.interval === "year" ? "year" : "month") : "";
      var renewalDate = document.querySelector("[data-renewal-date]");
      var renewal = parentRenewalAt
        ? parentDate(parentRenewalAt)
        : onStripeTrial() && trialInfo() && trialInfo().endsAt
        ? parentDate(trialInfo().endsAt)
        : "Not scheduled";
      if (renewalDate) renewalDate.textContent = renewal;
      var planPeriod = document.querySelector("[data-plan-period]");
      if (planPeriod) planPeriod.textContent = paid ? (activePlan().key === "yearly" ? "Yearly plan" : "Monthly plan") : "Payment pending";
      document.getElementById("preview-children").textContent = children.length + (children.length === 1 ? " profile" : " profiles");
      document.getElementById("preview-subscription").textContent = paid ? activePlan().name.replace("Family ", "") : "Pending";
      document.getElementById("preview-access").textContent = paid && children.length ? "Unlocked" : "Locked";
      if (capLabel) capLabel.textContent = capValue + " min";
      updateChildCards();
      renderSubscriptionState();
    }

    function validateForm() {
      if (!validateParentEmail()) {
        setParentTab("support");
        return false;
      }
      var fields = Array.from(form.querySelectorAll("input, select"));
      for (var i = 0; i < fields.length; i += 1) {
        if (!fields[i].checkValidity()) {
          // Surface WHERE the problem is instead of silently aborting the save.
          // A common trap: adding a second child but leaving its required grade
          // unset — without this the whole save is blocked with only a native
          // tooltip the parent can easily miss, so the new child looks "lost".
          var field = fields[i];
          var panel = field.closest("[data-parent-panel]");
          if (panel && panel.dataset.parentPanel) setParentTab(panel.dataset.parentPanel);
          var card = field.closest(".child-profile");
          if (card) {
            var idx = Array.from(document.querySelectorAll(".child-profile")).indexOf(card);
            activeChildIndex = Math.max(0, idx);
            updateChildCards();
            var who = (card.querySelector('[name="studentName"]') || {}).value;
            who = (who || "").trim() || ("Child " + (idx + 1));
            card.classList.add("needs-attention");
            setTimeout(function () { card.classList.remove("needs-attention"); }, 2400);
            if (completionTitle) completionTitle.textContent = "Finish " + who + "'s profile";
            if (completionText) completionText.textContent = "Each student needs a name and a grade before the family can be saved.";
          } else if (completionTitle && completionText) {
            completionTitle.textContent = "Complete your details";
            completionText.textContent = "Fill in the highlighted field before saving the family.";
          }
          // Let the tab switch paint before scrolling/focusing the field.
          setTimeout(function () {
            try { field.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
            field.focus();
            field.reportValidity();
          }, 60);
          return false;
        }
      }
      if (!paid) {
        paymentState.textContent = "Complete Stripe payment before saving";
        paymentState.className = "state-chip error";
        setParentTab("subscription");
        return false;
      }
      if (!childProfiles().length) {
        completionTitle.textContent = "Add a child profile";
        completionText.textContent = "At least one child profile is needed before the extension can unlock tools.";
        setParentTab("overview");
        return false;
      }
      return true;
    }

    tabButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setParentTab(button.dataset.parentTab);
      });
    });

    var saveControlsButton = document.getElementById("save-controls");
    if (saveControlsButton) saveControlsButton.addEventListener("click", saveControls);
    var supportSendButton = document.getElementById("support-send");
    if (supportSendButton) supportSendButton.addEventListener("click", sendSupportMessage);
    var supportMessageEl = document.getElementById("support-message");
    var supportCharCountEl = document.getElementById("support-charcount");
    function updateSupportCharCount() {
      if (!supportMessageEl || !supportCharCountEl) return;
      var len = supportMessageEl.value.length;
      supportCharCountEl.textContent = len + " / 300";
      supportCharCountEl.classList.toggle("at-limit", len >= 300);
    }
    if (supportMessageEl) supportMessageEl.addEventListener("input", updateSupportCharCount);
    updateSupportCharCount();

    demoButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        applyDemo(button.dataset.demoAccount);
      });
    });

    if (googleLoginButton) {
      googleLoginButton.addEventListener("click", startGoogleLogin);
    }
    setupParentLoginGate();

    if (changePasswordButton) {
      changePasswordButton.addEventListener("click", function () {
        var passwordFields = changePasswordButton.closest(".account-setting-row")?.nextElementSibling;
        if (passwordFields && passwordFields.classList.contains("hidden")) {
          passwordFields.classList.remove("hidden");
          var firstPasswordField = passwordFields.querySelector("input");
          if (firstPasswordField) firstPasswordField.focus();
          return;
        }
        changeParentPassword().catch(function (error) {
          showAccountStatus(error.detail || error.error || "Password update failed", "error");
        });
      });
    }

    if (requestEmailChangeButton) {
      requestEmailChangeButton.addEventListener("click", function () {
        var emailFields = requestEmailChangeButton.closest(".account-setting-row")?.nextElementSibling;
        if (emailFields && emailFields.classList.contains("hidden")) {
          emailFields.classList.remove("hidden");
          var newEmailField = emailFields.querySelector("input");
          if (newEmailField) newEmailField.focus();
          return;
        }
        requestParentEmailChange().catch(function (error) {
          showAccountStatus(error.detail || error.error || "Could not send code", "error");
        });
      });
    }

    if (confirmEmailChangeButton) {
      confirmEmailChangeButton.addEventListener("click", function () {
        confirmParentEmailChange().catch(function (error) {
          showAccountStatus(error.detail || error.error || "Email update failed", "error");
        });
      });
    }

    if (requestDeleteAccountButton) {
      requestDeleteAccountButton.addEventListener("click", function () {
        requestAccountDeletion().catch(function (error) {
          showAccountStatus(error.detail || error.error || "Deletion request failed", "error");
        });
      });
    }

    // Each plan card carries its own CTA, so checkout is a plain function rather
    // than a click on a separate button at the bottom of the page.
    async function startStripeCheckout() {
      if (!validateParentEmail()) {
        setParentTab("support");
        return;
      }
      var plan = selectedPlan();
      var primaryChild = childProfiles()[0] || {};
      localStorage.setItem(PENDING_CHECKOUT_PLAN_KEY, plan.key);
      paymentState.textContent = "Opening Stripe";
      paymentState.className = "state-chip warning";
      try {
        var response = await fetch("/api/stripe/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            priceId: plan.stripePriceId,
            planName: plan.name,
            promoCode: plan.promoCode,
            parentEmail: formValue("email"),
            parentName: formValue("parentName"),
            password: formValue("password"),
            studentName: primaryChild.studentName || "",
            grade: primaryChild.grade || "",
            readingLevel: primaryChild.readingLevel || ""
          })
        });
        var result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "Stripe checkout failed");
        }
        if (result.url) {
          window.location.href = result.url;
          return;
        }
        paid = true;
        setPaidPlan(plan.key, "Ready to save", plan.name + " is active. Review child profiles, learning goals, and rewards, then save the family profile.");
        paymentState.textContent = result.mode === "mock" ? "Demo checkout active" : "Subscription active";
        paymentState.className = "state-chip ok";
      } catch (error) {
        localStorage.removeItem(PENDING_CHECKOUT_PLAN_KEY);
        paymentState.textContent = error.message;
        paymentState.className = "state-chip error";
        completionTitle.textContent = "Checkout needs attention";
        completionText.textContent = "Check the Stripe Price ID in Admin, then try checkout again.";
      }
      preview();
    }

      planInputs.forEach(function (input) {
      input.addEventListener("change", function () {
        renderPromotionOffer();
        if (!paid) {
          paymentState.textContent = selectedPlan().price + " selected";
          paymentState.className = "state-chip warning";
        }
        preview();
      });
    });

    if (copyPromoCode) {
      copyPromoCode.addEventListener("click", async function () {
        var promo = activePromo || eligiblePromotion();
        if (!promo) return;
        try {
          await navigator.clipboard.writeText(promo.code);
          if (promoState) {
            promoState.textContent = "Copied";
            promoState.className = "state-chip ok";
            promoState.classList.remove("hidden");
          }
        } catch (error) {
          if (promoState) {
            promoState.textContent = promo.code;
            promoState.className = "state-chip warning";
            promoState.classList.remove("hidden");
          }
        }
      });
    }

    updatePaymentMethod.addEventListener("click", async function () {
      paymentState.textContent = "Opening billing portal";
      paymentState.className = "state-chip warning";
      try {
        var response = await fetch("/api/stripe/create-customer-portal-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: formValue("email"),
            returnUrl: window.location.origin + "/index.html"
          })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to open billing portal");
        if (result.url) {
          window.location.href = result.url;
          return;
        }
        paymentState.textContent = "Billing portal ready";
        paymentState.className = "state-chip ok";
        completionTitle.textContent = "Payment method";
        completionText.textContent = result.message || "Stripe billing portal will open here when the customer exists in Stripe.";
      } catch (error) {
        paymentState.textContent = "Billing portal unavailable";
        paymentState.className = "state-chip error";
        completionTitle.textContent = "Payment method";
        completionText.textContent = error.message;
      }
      preview();
    });

    function moneyStr(n) { return Number.isInteger(n) ? String(n) : Number(n).toFixed(2); }
    function yearlyUpgradeOffer() {
      var pricing = readPricing();
      var up = pricing.yearlyUpgrade || { bonusMonths: 3, discountAmount: 0, note: "" };
      var base = Number((pricing.yearly || {}).amount || 0);
      var planPromotion = configuredPromotionForPlan("yearly");
      var off = Math.max(0, Number(up.discountAmount || 0));
      var configuredPrice = planPromotion ? Number(planPromotion.promoPrice || 0) : 0;
      var upgradePrice = off > 0 ? Math.max(0, Math.round((base - off) * 100) / 100) : 0;
      // A promotion override set for the yearly plan wins: it is the more
      // specific, explicitly-priced instruction, and an admin who types a yearly
      // override price expects to see exactly that price in the portal. The
      // upgrade discount is the standing offer used when no override is set.
      var usesPlanPromotion = Boolean(planPromotion && configuredPrice > 0);
      var usesUpgradeOffer = !usesPlanPromotion && (off > 0 || Boolean(String(up.note || "").trim()));
      var price = usesPlanPromotion
        ? configuredPrice
        : upgradePrice > 0 ? upgradePrice : base;
      var effectiveOff = base > 0 && price < base ? Math.round((base - price) * 100) / 100 : 0;
      // What a year on this plan costs versus twelve monthly charges — the
      // headline reason to upgrade when no bonus months are configured.
      var monthlyAmount = Number((pricing.monthly || {}).amount || 0);
      var annualSavings = monthlyAmount > 0 && price > 0
        ? Math.max(0, Math.round((monthlyAmount * 12 - price) * 100) / 100)
        : 0;
      // The same saving expressed as months — "5 months free" lands harder than
      // a dollar figure. Floored, so the claim is never larger than the truth.
      var freeMonths = monthlyAmount > 0 ? Math.floor(annualSavings / monthlyAmount) : 0;
      return {
        freeMonths: freeMonths,
        bonusMonths: Math.max(0, Number(up.bonusMonths || 0)),
        annualSavings: annualSavings,
        discountAmount: usesPlanPromotion ? effectiveOff : off,
        basePrice: base,
        price: price,
        priceStr: moneyStr(price),
        baseStr: moneyStr(base),
        note: usesPlanPromotion ? (planPromotion.code + (planPromotion.description ? ": " + planPromotion.description : "")) : (up.note || ""),
        promoCode: usesPlanPromotion ? planPromotion.code : "",
        promoDescription: usesPlanPromotion ? planPromotion.description || "" : up.note || "",
        usesPlanPromotion: usesPlanPromotion,
        usesUpgradeOffer: usesUpgradeOffer
      };
    }

    function renderCurrentPackageFacts(plan) {
      var el = document.getElementById("current-package-facts");
      if (!el) return;
      var pricing = readPricing();
      var members = Number((pricing[plan.key] || pricing.monthly || {}).familyMemberCount || 3);
      var facts = [];
      var trialingNow = onStripeTrial();
      facts.push({
        icon: cancellationScheduled || trialingNow ? "clock" : "check-circle",
        text: cancellationScheduled
          ? (trialingNow ? "Current plan cancels on " + parentDate(cancellationAccessUntil || trialEndsText()) : "Cancels " + parentDate(cancellationAccessUntil))
          : trialingNow
          ? "Free trial · ends " + trialEndsText()
          : yearlyUpgradeScheduled
          ? "Yearly upgrade confirmed"
          : "Active subscription"
      });
      // During a trial the meaningful date is when billing starts, which the
      // fact above already states — a "renews monthly" line would imply a charge
      // cycle that has not begun yet.
      if (trialingNow) {
        facts.push({ icon: "credit-card", text: cancellationScheduled ? "No charge will be made" : "Billing starts " + trialEndsText() });
      }
      var renewalIso = yearlyUpgradeScheduled && yearlyUpgradeInfo && yearlyUpgradeInfo.yearlyNextRenewalAt
        ? new Date(Number(yearlyUpgradeInfo.yearlyNextRenewalAt) * 1000).toISOString()
        : parentRenewalAt;
      if (renewalIso && !cancellationScheduled && !trialingNow) {
        facts.push({ icon: "calendar", text: (plan.key === "monthly" ? "Renews monthly · next on " : "Renews ") + parentDate(renewalIso) });
      }
      facts.push({ icon: "users-round", text: "Up to " + members + " family members" });
      facts.push({ icon: "puzzle", text: "Chrome extension unlocked" });
      el.innerHTML = facts.map(function (f) {
        return "<li><i data-lucide='" + f.icon + "'></i>" + text(f.text) + "</li>";
      }).join("");
      renderIcons();
    }

    function renderRailPromo() {
      var el = document.getElementById("rail-yearly-promo");
      if (!el) return;
      var show = paid && activePlanKey === "monthly" && !onNoCardTrial() && !cancellationScheduled && !yearlyUpgradeScheduled;
      el.classList.toggle("hidden", !show);
      if (!show) return;
      var o = yearlyUpgradeOffer();
      var copyEl = document.getElementById("rail-promo-copy");
      var detailEl = document.getElementById("rail-promo-detail");
      if (copyEl) {
        var extras = [];
        if (o.bonusMonths > 0) extras.push(o.bonusMonths + " bonus month" + (o.bonusMonths === 1 ? "" : "s"));
        if (o.discountAmount > 0) extras.push("save $" + o.discountAmount);
        if (o.promoCode) extras.push("code " + o.promoCode);
        copyEl.textContent = "Switch to yearly for $" + o.priceStr + "/yr" + (extras.length ? " · " + extras.join(" · ") : "");
      }
      if (detailEl) detailEl.textContent = o.promoDescription || "Keep learning all year with one simple renewal.";
      renderIcons();
    }

    function renderUpgradeOffer() {
      var el = document.getElementById("upgrade-offer");
      if (!el) return;
      var show = upgradeYearly && !upgradeYearly.classList.contains("hidden");
      el.hidden = !show;
      if (!show) return;
      var o = yearlyUpgradeOffer();
      var price = o.discountAmount > 0
        ? "<span class='strike'>$" + o.baseStr + "</span><b>$" + o.priceStr + "/yr</b>"
        : "<b>$" + o.priceStr + "/yr</b>";
      el.innerHTML = price + (o.bonusMonths > 0 ? " · <b>+" + o.bonusMonths + " bonus mo</b>" : "") +
        "<br>plus your unused days this month" + (o.note ? "<br>" + text(o.note) : "");
    }

    function openUpgradeModal() {
      var o = yearlyUpgradeOffer();
      var trialing = onStripeTrial();
      var perks = document.getElementById("upgrade-perks");
      if (perks) {
        perks.innerHTML = trialing
          ? "<li><i data-lucide='calendar-check'></i><span>Keep your current <b>free trial</b></span></li>" +
            "<li><i data-lucide='clock'></i><span>Yearly billing begins on <b>" + text(trialEndsText()) + "</b></span></li>" +
            "<li><i data-lucide='shield-check'></i><span><b>No charge today</b> — your card is billed when the trial ends</span></li>"
          : "<li><i data-lucide='calendar-check'></i><span>A full <b>12 months</b> of KiddieGPT</span></li>" +
            (o.bonusMonths > 0 ? "<li><i data-lucide='gift'></i><span><b>+" + o.bonusMonths + " bonus month" + (o.bonusMonths === 1 ? "" : "s") + "</b> added on top</span></li>" : "") +
            "<li><i data-lucide='clock'></i><span>The <b>unused days left in your current month</b> are carried over — you lose nothing</span></li>" +
            "<li><i data-lucide='shield-check'></i><span>Your monthly plan is cancelled at period end, so you're <b>never double-charged</b></span></li>";
      }
      var priceRow = document.getElementById("upgrade-price-row");
      if (priceRow) {
        priceRow.innerHTML = (o.discountAmount > 0 ? "<span class='was'>$" + o.baseStr + "</span>" : "") +
          "<span class='now'>$" + o.priceStr + "<span>/year</span></span>" +
          (o.discountAmount > 0 ? "<span class='save'>Save $" + o.discountAmount + "</span>" : "");
      }
      var noteEl = document.getElementById("upgrade-modal-note");
      if (noteEl) {
        noteEl.textContent = trialing
          ? "Your first yearly charge starts when the trial ends on " + trialEndsText() + "."
          : o.note || "";
        noteEl.hidden = false;
      }
      var modal = document.getElementById("upgrade-modal");
      if (modal) modal.hidden = false;
      renderIcons();
    }
    function closeUpgradeModal() { var m = document.getElementById("upgrade-modal"); if (m) m.hidden = true; }

    async function performYearlyUpgrade() {
      var plan = planByKey("yearly");
      upgradeYearly.disabled = true;
      paymentState.textContent = "Scheduling yearly upgrade";
      paymentState.className = "state-chip warning";
      try {
        var response = await parentAuthFetch("/api/stripe/upgrade-yearly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: formValue("email"),
            parentName: formValue("parentName"),
            yearlyPriceId: plan.stripePriceId,
            promoCode: yearlyUpgradeOffer().promoCode
          })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || "Yearly upgrade failed");
        var trialingResult = Boolean(result.trialing);
        yearlyUpgradeInfo = {
          status: trialingResult ? "trialing" : "scheduled",
          accessMonths: result.accessMonths || (trialingResult ? 12 : 15),
          yearlyNextRenewalAt: result.yearlyNextRenewalAt || null,
          monthlyEndsAt: result.monthlyEndsAt || null,
          chargedAt: trialingResult ? "" : new Date().toISOString(),
          trialEndsAt: result.trialEndsAt || ""
        };
        yearlyUpgradeScheduled = !trialingResult;
        setPaidPlan("yearly", trialingResult ? "Yearly billing selected" : "Yearly upgrade confirmed", result.message || yearlyUpgradeDetailText(yearlyUpgradeInfo));
        paymentState.textContent = trialingResult ? "Yearly billing selected" : "Yearly upgrade confirmed";
        paymentState.className = "state-chip ok";
        if (currentPackageNote) currentPackageNote.textContent = trialingResult
          ? "Yearly billing starts when your trial ends on " + trialEndsText() + "."
          : yearlyUpgradeDetailText(yearlyUpgradeInfo);
      } catch (error) {
        paymentState.textContent = "Upgrade needs attention";
        paymentState.className = "state-chip error";
        completionTitle.textContent = "Yearly upgrade not scheduled";
        completionText.textContent = error.message;
      } finally {
        upgradeYearly.disabled = false;
      }
      preview();
    }

    // Same buttons serve both states: for a subscriber they open the upgrade
    // modal; for a signup they pick that plan and go straight to Checkout.
    function choosePlanAndCheckout(key) {
      setPlanChoice(key);
      updatePlanTiles();
      startStripeCheckout();
    }
    upgradeYearly.addEventListener("click", function () {
      if (!paid || onNoCardTrial()) return choosePlanAndCheckout("monthly");
      openUpgradeModal();
    });
    if (upgradeYearlyTileButton) upgradeYearlyTileButton.addEventListener("click", function () {
      if (!paid || onNoCardTrial()) return choosePlanAndCheckout("yearly");
      openUpgradeModal();
    });
    var railYearlyPromo = document.getElementById("rail-yearly-promo");
    if (railYearlyPromo) railYearlyPromo.addEventListener("click", function () { setParentTab("subscription"); openUpgradeModal(); });
    var upgradeConfirmBtn = document.getElementById("upgrade-confirm");
    if (upgradeConfirmBtn) upgradeConfirmBtn.addEventListener("click", function () { closeUpgradeModal(); performYearlyUpgrade(); });
    var upgradeCancelBtn = document.getElementById("upgrade-cancel");
    if (upgradeCancelBtn) upgradeCancelBtn.addEventListener("click", closeUpgradeModal);
    var upgradeCloseBtn = document.getElementById("upgrade-modal-close");
    if (upgradeCloseBtn) upgradeCloseBtn.addEventListener("click", closeUpgradeModal);
    var upgradeModalEl = document.getElementById("upgrade-modal");
    if (upgradeModalEl) upgradeModalEl.addEventListener("click", function (event) { if (event.target === upgradeModalEl) closeUpgradeModal(); });

    if (cancelSwitchYearly) cancelSwitchYearly.addEventListener("click", function () {
      closeUpgradeModal();
      cancelFlow.classList.add("hidden");
      subscriptionMain.classList.remove("hidden");
      if (onNoCardTrial()) {
        setParentTab("subscription");
        setPlanChoice("yearly");
        paymentState.textContent = "Choose yearly billing";
        paymentState.className = "state-chip warning";
        completionTitle.textContent = "Choose yearly billing";
        completionText.textContent = "Complete checkout to keep access after your trial ends.";
        return;
      }
      openUpgradeModal();
    });

    if (resumeSubscription) {
      resumeSubscription.addEventListener("click", async function () {
        resumeSubscription.disabled = true;
        paymentState.textContent = "Restoring";
        paymentState.className = "state-chip warning";
        try {
          var response = await parentAuthFetch("/api/stripe/resume-subscription", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
          });
          var result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not restore the plan.");
          cancellationScheduled = false;
          cancellationAccessUntil = "";
          await syncSubscriptionFromEntitlement().catch(function () {});
          setPaidPlan(activePlanKey, "Plan restored", result.message || "Your plan will continue.");
        } catch (error) {
          paymentState.textContent = "Could not restore";
          paymentState.className = "state-chip error";
          completionTitle.textContent = "Plan not restored";
          completionText.textContent = error.message;
        } finally {
          resumeSubscription.disabled = false;
        }
      });
    }

    cancelSubscription.addEventListener("click", function () {
      prepareCancellationFlow();
      subscriptionMain.classList.add("hidden");
      cancelFlow.classList.remove("hidden");
      completionTitle.textContent = "Cancellation started";
      completionText.textContent = isYearlySubscription()
        ? "Choose a reason, then confirm cancellation of the next renewal. Access stays active through the paid plan end date."
        : "Choose a reason, then accept the save offer or continue cancellation.";
      renderIcons();
    });

    backToSubscription.addEventListener("click", function () {
      cancelFlow.classList.add("hidden");
      subscriptionMain.classList.remove("hidden");
      completionTitle.textContent = paid ? "Subscription active" : "Waiting for payment";
      completionText.textContent = paid ? activePlan().name + " remains active." : "Pay, add a child profile, then save the family profile.";
      preview();
      renderIcons();
    });

    acceptDiscount.addEventListener("click", async function () {
      if (isYearlySubscription()) {
        completionTitle.textContent = "Yearly renewal";
        completionText.textContent = "Yearly subscriptions do not use the monthly save offer. You can cancel renewal and keep access through the paid plan end date.";
        return;
      }
      acceptDiscount.disabled = true;
      paymentState.textContent = "Applying discount";
      paymentState.className = "state-chip warning";
      try {
        var response = await parentAuthFetch("/api/stripe/apply-retention-discount", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: formValue("email"),
            reason: cancelReason ? cancelReason.value : "Cancellation save offer"
          })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to apply discount");

        paid = true;
        retentionOfferAccepted = true;
        cancelFlow.classList.add("hidden");
        subscriptionMain.classList.remove("hidden");
        var promo = cancellationPromoConfig();
        var amountOff = Number(result.amountOff || promo.amountOff || 0);
        paymentState.textContent = result.alreadyApplied ? "$" + amountOff + " off already applied" : "$" + amountOff + " off applied";
        paymentState.className = "state-chip ok";
        completionTitle.textContent = "Discount accepted";
        completionText.textContent = result.message || "The $" + amountOff + " discount will be applied automatically to the next invoice. No code is needed.";
        if (currentPackageNote) currentPackageNote.textContent = onStripeTrial()
          ? "$" + amountOff + " off will apply when billing starts on " + trialEndsText() + ". Your current plan stays active."
          : "Save offer accepted: $" + amountOff + " off will apply automatically to the next invoice.";
      } catch (error) {
        paymentState.textContent = "Discount needs attention";
        paymentState.className = "state-chip error";
        completionTitle.textContent = "Discount not applied";
        completionText.textContent = error.message;
      } finally {
        acceptDiscount.disabled = false;
      }
      preview();
    });

    confirmCancel.addEventListener("click", async function () {
      confirmCancel.disabled = true;
      paymentState.textContent = "Scheduling cancellation";
      paymentState.className = "state-chip warning";
      try {
        var response = await parentAuthFetch("/api/stripe/request-cancellation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: cancelReason ? cancelReason.value : "Parent requested cancellation"
          })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to schedule cancellation");
        if (result.trialing) {
          cancellationScheduled = true;
          cancellationAccessUntil = result.cancelAccessUntil || result.trialEndsAt || "";
          cancelFlow.classList.add("hidden");
          subscriptionMain.classList.remove("hidden");
          paymentState.textContent = "Trial ends " + parentDate(cancellationAccessUntil);
          paymentState.className = "state-chip warning";
          completionTitle.textContent = "Trial ending";
          completionText.textContent = "Your trial is scheduled to end on " + parentDate(cancellationAccessUntil) + ". Access continues until then, and you will not be charged.";
          if (currentPackageNote) {
            currentPackageNote.textContent = "Trial ends " + parentDate(cancellationAccessUntil) + " — no charge.";
          }
          await syncSubscriptionFromEntitlement().catch(function () {});
          preview();
          return;
        }
        if (result.refunded) {
          // Cancelled inside the refund window: refunded in full, access over.
          cancelFlow.classList.add("hidden");
          subscriptionMain.classList.remove("hidden");
          // Refresh entitlement first — it repaints the generic unpaid copy, so
          // the refund wording has to be applied after it, not before.
          await syncSubscriptionFromEntitlement().catch(function () {});
          setUnpaidSubscription(
            "Refunded and cancelled",
            result.message || "Your payment was refunded in full and extension access has ended.",
            "Refunded"
          );
          if (currentPackageNote) {
            currentPackageNote.textContent = "Cancelled within the refund window. Your payment was refunded in full and extension access has ended.";
          }
          preview();
          return;
        }
        paid = true;
        cancellationScheduled = true;
        cancellationAccessUntil = result.cancelAccessUntil || "";
        cancelFlow.classList.add("hidden");
        subscriptionMain.classList.remove("hidden");
        paymentState.textContent = "Cancels " + parentDate(cancellationAccessUntil);
        paymentState.className = "state-chip warning";
        completionTitle.textContent = isYearlySubscription() ? "Renewal cancelled" : "Cancellation scheduled";
        completionText.textContent = isYearlySubscription()
          ? "Your yearly renewal is cancelled. Your child can keep using the extension until " + parentDate(cancellationAccessUntil) + "."
          : "Your subscription is scheduled to cancel on " + parentDate(cancellationAccessUntil) + ". Your child can keep using the extension until then.";
        if (currentPackageNote) {
          currentPackageNote.textContent = isYearlySubscription()
            ? "Renewal cancelled: your child keeps extension access until " + parentDate(cancellationAccessUntil) + "."
            : "Cancellation scheduled: your child keeps extension access until " + parentDate(cancellationAccessUntil) + ".";
        }
        await syncSubscriptionFromEntitlement().catch(function () {});
      } catch (error) {
        paymentState.textContent = "Cancellation needs attention";
        paymentState.className = "state-chip error";
        completionTitle.textContent = "Cancellation not scheduled";
        completionText.textContent = error.message;
      } finally {
        confirmCancel.disabled = false;
      }
      preview();
    });

    function addBlankChildProfile() {
      var count = document.querySelectorAll(".child-profile").length;
      if (count >= 3) {
        completionTitle.textContent = "Family plan limit";
        completionText.textContent = "Your family plan includes up to 3 child profiles.";
        return;
      }
      var sourceSlide = studentSlides()[0];
      if (!sourceSlide) return;
      var clone = sourceSlide.cloneNode(true);
      removeCloneIds(clone);
      clone.dataset.slideIndex = String(count);
      var profile = clone.querySelector(".child-profile");
      profile.dataset.childId = "child_" + makeId();
      profile.dataset.readingLevel = "";
      profile.querySelector('[name="studentName"]').value = "";
      profile.querySelector('[name="grade"]').value = "5";
      var goalList = profile.querySelector(".goal-reward-list");
      if (goalList) {
        goalList.innerHTML = "";
        goalList.appendChild(createGoalRow());
      }
      var progressList = clone.querySelector(".progress-list");
      if (progressList) progressList.innerHTML = '<div class="progress-empty">Your child\'s activity from the KiddieGPT extension will show here.</div>';
      childList.appendChild(clone);
      activeChildIndex = count;
      updateChildCards();
      preview();
      renderIcons();
      setTimeout(function () {
        var nameInput = profile.querySelector('[name="studentName"]');
        if (nameInput) nameInput.focus();
      }, 50);
    }

    function closeDeleteProfileDialog() {
      var modal = document.getElementById("delete-profile-modal");
      if (modal) modal.hidden = true;
      deleteProfileCandidate = null;
    }

    function openDeleteProfileDialog(profile) {
      if (!profile || document.querySelectorAll(".child-profile").length <= 1) return;
      deleteProfileCandidate = profile;
      var nameInput = profile.querySelector('[name="studentName"]');
      var name = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "this student";
      var nameEl = document.getElementById("delete-profile-name");
      if (nameEl) nameEl.textContent = name;
      var modal = document.getElementById("delete-profile-modal");
      if (!modal) return;
      modal.hidden = false;
      renderIcons();
      var cancelButton = document.getElementById("cancel-delete-profile");
      if (cancelButton) cancelButton.focus();
    }

    async function confirmDeleteProfile() {
      var profile = deleteProfileCandidate;
      if (!profile || document.querySelectorAll(".child-profile").length <= 1) {
        closeDeleteProfileDialog();
        return;
      }
      var confirmButton = document.getElementById("confirm-delete-profile");
      var errorEl = document.getElementById("delete-profile-modal-error");
      var childId = profile.dataset.childId || "";
      if (confirmButton) confirmButton.disabled = true;
      if (errorEl) errorEl.textContent = "";
      try {
        // Loaded profiles have a stable id and are removed from the backend now.
        // New unsaved cards do not exist on the server yet, so those only need
        // to be removed from the local workspace.
        if (childId && parentToken()) await deleteChildOnBackend(childId);
        var slide = profile.closest(".student-workspace-slide");
        if (slide) slide.remove();
        activeChildIndex = Math.min(activeChildIndex, document.querySelectorAll(".child-profile").length - 1);
        closeDeleteProfileDialog();
        updateChildCards();
        preview();
        if (profileSaveState) {
          profileSaveState.textContent = "Profile removed";
          setTimeout(function () { if (profileSaveState) profileSaveState.textContent = ""; }, 3500);
        }
        renderIcons();
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message || "Unable to remove the student profile. Try again.";
        if (confirmButton) confirmButton.disabled = false;
      }
    }

    var deleteProfileModal = document.getElementById("delete-profile-modal");
    var deleteProfileClose = document.getElementById("delete-profile-modal-close");
    var deleteProfileCancel = document.getElementById("cancel-delete-profile");
    var deleteProfileConfirm = document.getElementById("confirm-delete-profile");
    if (deleteProfileClose) deleteProfileClose.addEventListener("click", closeDeleteProfileDialog);
    if (deleteProfileCancel) deleteProfileCancel.addEventListener("click", closeDeleteProfileDialog);
    if (deleteProfileConfirm) deleteProfileConfirm.addEventListener("click", confirmDeleteProfile);
    if (deleteProfileModal) deleteProfileModal.addEventListener("click", function (event) {
      if (event.target === deleteProfileModal) closeDeleteProfileDialog();
    });

    if (addChild) addChild.addEventListener("click", addBlankChildProfile);
    var profileEditorToggle = document.getElementById("toggle-profile-editor");
    var profileEditor = document.getElementById("profile-editor");
    if (profileEditorToggle && profileEditor) {
      profileEditorToggle.addEventListener("click", function () {
        var open = profileEditor.hidden;
        profileEditor.hidden = !open;
        profileEditorToggle.classList.toggle("is-open", open);
        var label = profileEditorToggle.querySelector("span");
        if (label) label.textContent = open ? "Hide profile details" : "Edit profile details";
        renderIcons();
      });
    }
    if (previousChild) previousChild.addEventListener("click", function () {
      if (activeChildIndex > 0) {
        activeChildIndex -= 1;
        updateChildCards();
      }
    });
    if (nextChild) nextChild.addEventListener("click", function () {
      var count = document.querySelectorAll(".child-profile").length;
      if (activeChildIndex < count - 1) {
        activeChildIndex += 1;
        updateChildCards();
      }
    });

    childList.addEventListener("click", function (event) {
      var addGoal = event.target.closest(".add-goal");
      if (addGoal) {
        var goalProfile = addGoal.closest(".child-profile");
        if (goalProfile.querySelectorAll(".goal-reward-row").length >= 7) {
          updateGoalRows(goalProfile);
          return;
        }
        goalProfile.querySelector(".goal-reward-list").appendChild(createGoalRow());
        updateGoalRows(goalProfile);
        renderIcons();
        return;
      }

      var completedToggle = event.target.closest(".show-completed");
      if (completedToggle) {
        updateGoalRows(completedToggle.closest(".child-profile"));
        return;
      }

      var deleteGoal = event.target.closest(".delete-goal");
      if (deleteGoal) {
        var row = deleteGoal.closest(".goal-reward-row");
        var rowProfile = deleteGoal.closest(".child-profile");
        if (rowProfile.querySelectorAll(".goal-reward-row").length > 1) {
          row.remove();
          updateGoalRows(rowProfile);
          preview();
        }
        return;
      }

      var remove = event.target.closest(".remove-child");
      if (!remove) return;
      var profile = remove.closest(".child-profile");
      openDeleteProfileDialog(profile);
    });

    childList.addEventListener("input", function () {
      preview();
    });

    childList.addEventListener("change", function (event) {
      var goalComplete = event.target.closest('[name="goalComplete"]');
      if (goalComplete) updateGoalRows(goalComplete.closest(".child-profile"));
      var completedToggle = event.target.closest(".show-completed");
      if (completedToggle) updateGoalRows(completedToggle.closest(".child-profile"));
      preview();
    });

    form.addEventListener("input", function (event) {
      if (event.target === form.elements.email) validateParentEmail();
      if (event.target.closest("#student-workspace-slides")) {
        return;
      }
      preview();
    });

    form.addEventListener("change", function () {
      preview();
    });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!validateForm()) return;

      var data = new FormData(form);
      var children = childProfiles();
      var primaryChild = children[0];
      var family = {
        id: makeId(),
        parentName: text(data.get("parentName")),
        email: text(data.get("email")),
        password: text(data.get("password")),
        loginType: "Parent",
        studentName: text(primaryChild.studentName),
        grade: text(primaryChild.grade),
        readingLevel: text(primaryChild.readingLevel),
        goal: text(primaryChild.goal),
        reward: text(primaryChild.reward),
        learningGoals: primaryChild.learningGoals,
        children: children.map(function (child) {
          return {
            id: child.id,
            studentName: text(child.studentName),
            grade: text(child.grade),
            readingLevel: text(child.readingLevel),
            goal: text(child.goal),
            reward: text(child.reward),
            learningGoals: child.learningGoals
          };
        }),
        plan: paid ? activePlan().name : selectedPlan().name,
        stripePriceId: paid ? activePlan().stripePriceId : selectedPlan().stripePriceId,
        promoCode: paid ? activePlan().promoCode : selectedPlan().promoCode,
        planPrice: paid ? activePlan().price : selectedPlan().price,
        subscriptionStatus: paid ? "active" : "pending",
        paymentStatus: paid ? "paid" : "pending",
        accountLocked: false,
        guardrails: {
          showSteps: true,
          blockDirectAnswers: true,
          weeklySummary: true,
          usageCap: Number(data.get("usageCap")) || 60
        },
        createdAt: new Date().toISOString()
      };

      finish.disabled = true;
      var savedFamily = await createFamilyOnBackend(family);
      finish.disabled = false;

      completionTitle.textContent = "Family is active";
      completionText.textContent =
        savedFamily.children.length + " child " +
        (savedFamily.children.length === 1 ? "profile is" : "profiles are") +
        " saved. Extension access is unlocked and synced with the subscription.";
      completionPanel.classList.add("is-active");
      renderIcons();
    });

    if (cap) cap.addEventListener("input", preview);
    // Deep-link from the extension when login hits no_account: /?signup=1&email=… lands on Create-account.
    (function applySignupDeepLink() {
      try {
        var qs = new URLSearchParams(window.location.search);
        var emailParam = String(qs.get("email") || "").trim();
        if (emailParam && parentLoginForm && parentLoginForm.elements.email) parentLoginForm.elements.email.value = emailParam;
        if (qs.get("signup") === "1") setParentAuthMode("signup");
        if (emailParam) validateParentEmail();
      } catch (e) {}
    })();
    loadAuthConfig().then(validateParentEmail);
    loadBackendState().then(async function () {
      updatePlanTiles();
      updateChildCards();
      await syncSubscriptionFromReturnUrl();
      await syncSubscriptionFromEntitlement().catch(function () {});
      validateParentEmail();
      preview();
      renderIcons();
    });
    updatePlanTiles();
    updateChildCards();
    syncSubscriptionFromReturnUrl().catch(function () {});
    preview();
    renderIcons();
  }

  function seedFamilies() {
    writeFamilies([{
      id: "fam_demo_parent",
      parentName: "Demo Parent",
      email: "parent.kiddiegpt@gmail.com",
      studentName: "Ava",
      readingLevel: "On track",
      grade: "Grade 5",
      goal: "Build confidence in math word problems",
      reward: "Movie night",
      learningGoals: [{ goal: "Build confidence in math word problems", reward: "Movie night", completed: false }],
      children: [
        { id: "child_demo_ava", studentName: "Ava", readingLevel: "On track", grade: "Grade 5", goal: "Build confidence in math word problems", reward: "Movie night", learningGoals: [{ goal: "Build confidence in math word problems", reward: "Movie night", completed: false }] }
      ],
      plan: moneyPlan(),
      subscriptionStatus: "active",
      paymentStatus: "paid",
      lastActivityDays: 1,
      favoriteTool: "Math Step Tutor",
      lifecycleStage: "Activated",
      supportNote: "Single demo parent for local testing.",
      guardrails: { showSteps: true, blockDirectAnswers: true, weeklySummary: true, usageCap: 60 },
      createdAt: new Date().toISOString()
    }]);
  }

  function setupAdminLoginGate() {
    var gate = document.getElementById("admin-auth-gate");
    var form = document.getElementById("admin-login-form");
    var error = document.getElementById("admin-login-error");
    var adminDemoLogin = document.querySelector("[data-admin-demo-login]");
    if (!gate || !form) return Promise.resolve(true);

    function showGate(message) {
      document.body.classList.add("admin-locked");
      gate.hidden = false;
      if (error) error.textContent = message || "";
    }

    function hideGate() {
      document.body.classList.remove("admin-locked");
      gate.hidden = true;
      if (error) error.textContent = "";
    }

    return new Promise(function (resolve) {
      var resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        hideGate();
        resolve(true);
      }

      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (error) error.textContent = "Signing in...";
        try {
          var response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              role: "admin",
              email: form.elements.email.value.trim(),
              password: form.elements.password.value
            })
          });
          var payload = await response.json();
          if (!response.ok || !payload.token) throw payload;
          localStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
          finish();
        } catch (loginError) {
          showGate(loginError.error || "Could not sign in. Check the admin email and password.");
        }
      });

      if (adminDemoLogin) {
        adminDemoLogin.addEventListener("click", function () {
          form.elements.email.value = "admin@kiddiegpt.demo";
          form.elements.password.value = "admin123";
          form.requestSubmit();
        });
      }

      if (!adminToken()) {
        showGate("");
        return;
      }

      apiFetch("/api/auth/me")
        .then(function (response) {
          if (!response.ok) throw new Error("expired");
          finish();
        })
        .catch(function () {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          showGate("Session expired. Sign in again.");
        });
    });
  }

  function setupAdminConsole() {
    // Identity lives in the left rail so the operator can see which account they
    // are on, and leave, without hunting through the topbar.
    var signOutButton = document.getElementById("admin-signout");
    if (signOutButton) {
      signOutButton.addEventListener("click", function () {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        window.location.reload();
      });
    }
    apiFetch("/api/auth/me")
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (me) {
        var el = document.getElementById("admin-identity-email");
        if (el && me && (me.email || (me.user && me.user.email))) el.textContent = me.email || me.user.email;
      })
      .catch(function () {});

    var table = document.getElementById("family-table");
    if (!table) return;

    var title = document.getElementById("admin-title");
    var navButtons = Array.from(document.querySelectorAll("[data-admin-view]"));
    var panels = Array.from(document.querySelectorAll("[data-admin-panel]"));
    var search = document.getElementById("family-search");
    var statusFilter = document.getElementById("status-filter");
    var lockedFilter = document.getElementById("locked-filter");
    var maxAiFilter = document.getElementById("max-ai-filter");
    var subscriptionFilter = document.getElementById("subscription-filter");
    var signupSearch = document.getElementById("signup-search");
    var signupDateFilter = document.getElementById("signup-date-filter");
    var renewalSubscriptionFilter = document.getElementById("renewal-subscription-filter");
    var renewalWindowFilter = document.getElementById("renewal-window-filter");
    var paidDateFilter = document.getElementById("paid-date-filter");
    var deletedDateFilter = document.getElementById("deleted-date-filter");
    var trialForm = document.getElementById("trial-form");
    var paymentSearch = document.getElementById("payment-search");
    var paymentStatusFilter = document.getElementById("payment-status-filter");
    var paymentPlanFilter = document.getElementById("payment-plan-filter");
    var cancellationFrom = document.getElementById("cancellation-from");
    var cancellationTo = document.getElementById("cancellation-to");
    var upgradeFrom = document.getElementById("upgrade-from");
    var upgradeTo = document.getElementById("upgrade-to");
    var cancelledFrom = document.getElementById("cancelled-from");
    var cancelledTo = document.getElementById("cancelled-to");
    var paymentFrom = document.getElementById("payment-from");
    var paymentTo = document.getElementById("payment-to");
    var paymentTableButtons = Array.from(document.querySelectorAll("[data-payment-table]"));
    var paymentTablePanels = Array.from(document.querySelectorAll("[data-payment-table-panel]"));
    var familyTableButtons = Array.from(document.querySelectorAll("[data-family-table]"));
    var familyTablePanels = Array.from(document.querySelectorAll("[data-family-table-panel]"));
    var logSearch = document.getElementById("log-search");
    var logTypeFilter = document.getElementById("log-type-filter");
    var exceptionSearch = document.getElementById("exception-search");
    var exceptionStatusFilter = document.getElementById("exception-status-filter");
    var exceptionForm = document.getElementById("exception-form");
    var exceptionParentSearch = document.getElementById("exception-parent-search") || exceptionSearch;
    var exceptionFamilySelect = document.getElementById("exception-family-select");
    var exceptionActionSelect = document.getElementById("exception-action-select");
    var exceptionAmount = document.getElementById("exception-amount");
    var exceptionMonths = document.getElementById("exception-months");
    var exceptionDays = document.getElementById("exception-days");
    var exceptionPercent = document.getElementById("exception-percent");
    var exceptionReason = document.getElementById("exception-reason");
    var exceptionEmailMessage = document.getElementById("exception-email-message");
    var exceptionSendEmail = document.getElementById("exception-send-email");
    var exceptionApply = document.getElementById("exception-apply");
    var exceptionActionState = document.getElementById("exception-action-state");
    var exceptionContext = document.getElementById("exception-context");
    var exceptionContextState = document.getElementById("exception-context-state");
    var seedButton = document.getElementById("seed-data");
    var pricingForm = document.getElementById("pricing-form");
    // False until syncPricingForm() has loaded live values into the inputs.
    var pricingFormSynced = false;
    var aiSettingsForm = document.getElementById("ai-settings-form");
    var clearOpenaiKey = document.getElementById("clear-openai-key");
    var aiSettingsState = document.getElementById("ai-settings-state");
    var stripeTestForm = document.getElementById("stripe-test-form");
    var bootstrapStripePrices = document.getElementById("bootstrap-stripe-prices");
    var emailTestForm = document.getElementById("email-test-form");
    var loginTestForm = document.getElementById("login-test-form");
    var devOutput = document.getElementById("dev-test-output");
    var exceptionOutput = document.getElementById("exception-output");
    var exceptionResultState = document.getElementById("exception-result-state");
    var workspace = document.querySelector(".admin-workspace");
    var expandedPayment = null;
    var activePaymentTable = "payments";
    var activeFamilyTable = "accounts";
    var selectedExceptionFamilyId = "";
    var customerDrawer = document.getElementById("customer-drawer");
    var customerDrawerBackdrop = document.getElementById("customer-drawer-backdrop");
    var customerDrawerBody = document.getElementById("customer-drawer-body");
    var customerDrawerTitle = document.getElementById("customer-drawer-title");
    var customerDrawerEmail = document.getElementById("customer-drawer-email");
    var openCustomerFamilyId = "";

    function setAdminView(name) {
      var labels = {
        overview: "Command",
        families: "Families",
        billing: "Billing",
        plans: "Plans",
        "ai-usage": "AI & Usage",
        emails: "Lifecycle",
        "email-studio": "Emails",
        support: "Support",
        logs: "Logs"
      };
      navButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.adminView === name);
      });
      panels.forEach(function (panel) {
        panel.classList.toggle("active", panel.dataset.adminPanel === name);
      });
      title.textContent = labels[name] || name.charAt(0).toUpperCase() + name.slice(1).replace("-", " ");
      if (name === "support") loadSupportConversations();
      if (name === "logs") loadLogDigest();
      if (name === "email-studio") loadEmailStudio();
      renderIcons();
    }

    function closeCustomerDrawer() {
      openCustomerFamilyId = "";
      if (customerDrawer) {
        customerDrawer.hidden = true;
        customerDrawer.setAttribute("aria-hidden", "true");
      }
      if (customerDrawerBackdrop) customerDrawerBackdrop.hidden = true;
      document.body.classList.remove("customer-drawer-open");
    }

    function customerTimelineMarkup(family) {
      var timeline = selectedFamilyTimeline(family).slice(0, 12);
      if (!timeline.length) return "<div class='drawer-empty'>No activity has been recorded for this family yet.</div>";
      return timeline.map(function (item) {
        return "<div class='drawer-timeline-item'><span>" + escapeHtml(rowDateTime(item.date)) + "</span><div><strong>" + escapeHtml(item.title) + "</strong><small>" + escapeHtml(item.kind + " · " + item.actor) + "</small><p>" + escapeHtml(item.detail) + "</p></div></div>";
      }).join("");
    }

    function renderCustomerDrawer(family) {
      if (!family || !customerDrawer || !customerDrawerBody) return;
      var risk = familyRisk(family);
      var action = familyNextAction(family);
      var children = childrenOf(family);
      var issues = reconciliationIssues(family);
      var tags = Array.isArray(family.adminTags) ? family.adminTags.join(", ") : (family.adminTags || "");
      var subscriptionActive = familySubscriptionActive(family);
      var locked = familyLocked(family);
      var latestPayment = latestPaymentForFamily(family);
      customerDrawerTitle.textContent = family.parentName || "Parent details";
      customerDrawerEmail.textContent = family.email || "";
      customerDrawerBody.innerHTML =
        "<div class='drawer-summary-grid'>" +
          "<div><span>Plan</span><strong>" + escapeHtml(familySubscriptionLabel(family)) + "</strong><small>" + escapeHtml(family.subscriptionStatus || "pending") + "</small></div>" +
          "<div><span>Risk</span>" + statusChip(risk.status) + "<small>" + escapeHtml(risk.label) + "</small></div>" +
          "<div><span>Next action</span><strong>" + escapeHtml(action.label) + "</strong><small>" + escapeHtml(action.detail) + "</small></div>" +
          "<div><span>Last extension use</span><strong>" + escapeHtml(rowDateTime(family.lastExtensionUseAt)) + "</strong><small>" + (daysSinceActivity(family) === 0 ? "Today" : daysSinceActivity(family) + " days ago") + "</small></div>" +
        "</div>" +
        "<div class='drawer-quick-actions'><span class='drawer-section-label'>Quick actions</span><div class='row-actions'>" +
          "<button type='button' class='table-action' data-customer-action='email' data-family-id='" + escapeHtml(familyRowId(family)) + "'>Send email</button>" +
          "<button type='button' class='table-action " + (locked ? "" : "danger") + "' data-customer-action='lock' data-family-id='" + escapeHtml(familyRowId(family)) + "'>" + (locked ? "Unlock account" : "Lock account") + "</button>" +
          "<button type='button' class='table-action " + (subscriptionActive ? "danger" : "") + "' data-customer-action='subscription' data-family-id='" + escapeHtml(familyRowId(family)) + "'>" + (subscriptionActive ? "End subscription" : "Start subscription") + "</button>" +
          "<button type='button' class='table-action' data-customer-action='exception' data-family-id='" + escapeHtml(familyRowId(family)) + "'>Billing adjustment</button>" +
        "</div></div>" +
        (issues.length ? "<div class='drawer-alerts'><span class='drawer-section-label'>Needs review</span>" + issues.map(function (issue) { return "<div><i data-lucide='triangle-alert'></i><span>" + escapeHtml(issue) + "</span></div>"; }).join("") + "</div>" : "") +
        "<section class='drawer-section'><div class='drawer-section-head'><span class='drawer-section-label'>Family</span><span class='muted-note'>" + children.length + " student" + (children.length === 1 ? "" : "s") + "</span></div>" +
          "<div class='drawer-children'>" + children.map(function (child) { var usage = usageToday(child); return "<div><strong>" + escapeHtml(child.studentName || "Student") + "</strong><small>Grade " + escapeHtml(child.grade || "-") + " · " + escapeHtml(child.readingLevel || "-") + "</small><span>" + usage.math + " math today · " + usage.voiceMin + " min voice</span></div>"; }).join("") + "</div>" +
        "</section>" +
        "<section class='drawer-section'><div class='drawer-section-head'><span class='drawer-section-label'>Billing</span><a class='stripe-link' href='https://dashboard.stripe.com/test/customers/" + encodeURIComponent(family.stripeCustomerId || "") + "' target='_blank' rel='noreferrer'>Stripe customer</a></div>" +
          "<div class='drawer-facts'><div><span>Payment status</span><strong>" + escapeHtml(paymentStatus(family)) + "</strong></div><div><span>Next renewal</span><strong>" + escapeHtml(familyNextRenewal(family)) + "</strong></div><div><span>Latest payment</span><strong>" + (latestPayment ? escapeHtml(moneyFromCents(latestPayment.amountCents)) : "-") + "</strong></div><div><span>Subscription ID</span><strong class='mono-text'>" + escapeHtml(family.stripeSubscriptionId || "-") + "</strong></div></div>" +
        "</section>" +
        "<section class='drawer-section'><div class='drawer-section-head'><span class='drawer-section-label'>Operator notes</span><span class='muted-note'>Saved to family record</span></div>" +
          "<label class='drawer-field'>Notes<textarea data-customer-notes rows='3' placeholder='Add context for the next support or billing decision.'>" + escapeHtml(family.adminNote || "") + "</textarea></label>" +
          "<label class='drawer-field'>Tags<input data-customer-tags value='" + escapeHtml(tags) + "' placeholder='billing, beta, high-touch'></label>" +
          "<button type='button' class='button primary' data-customer-save data-family-id='" + escapeHtml(familyRowId(family)) + "'>Save notes</button>" +
        "</section>" +
        "<section class='drawer-section'><div class='drawer-section-head'><span class='drawer-section-label'>Recent timeline</span><span class='muted-note'>" + selectedFamilyTimeline(family).length + " events</span></div><div class='drawer-timeline'>" + customerTimelineMarkup(family) + "</div></section>";
      customerDrawer.hidden = false;
      customerDrawer.setAttribute("aria-hidden", "false");
      if (customerDrawerBackdrop) customerDrawerBackdrop.hidden = false;
      document.body.classList.add("customer-drawer-open");
      renderIcons();
    }

    function openCustomerDrawer(familyId) {
      var family = familyById(familyId);
      if (!family) return;
      openCustomerFamilyId = familyId;
      renderCustomerDrawer(family);
    }

    function exportAdminTable(bodyId, fileName) {
      var body = document.getElementById(bodyId);
      var table = body && body.closest("table");
      if (!table) return;
      var headers = Array.from(table.querySelectorAll("thead th")).map(function (cell) { return (cell.innerText || "").trim(); });
      var rows = Array.from(body.querySelectorAll(":scope > tr")).filter(function (row) { return !row.classList.contains("payment-detail-row") && !row.querySelector(".empty-state"); }).map(function (row) {
        return Array.from(row.children).map(function (cell) { return (cell.innerText || "").replace(/\s+/g, " ").trim(); });
      });
      var csv = [headers].concat(rows).map(function (row) { return row.map(function (value) { return '"' + String(value).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
      var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      var link = document.createElement("a");
      link.href = url;
      link.download = (fileName || "kiddiegpt-export") + ".csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    // ---- Emails: provider settings + template gallery -------------------
    var emailTemplatesCache = [];
    async function loadEmailStudio() {
      try {
        var settings = await fetchJson("/api/admin/email-settings");
        var providerEl = document.getElementById("email-provider-state");
        if (providerEl) {
          providerEl.textContent = settings.configured ? ("Connected · " + settings.provider) : "Not configured";
          providerEl.className = "state-chip " + (settings.configured ? "active" : "warning");
        }
        var fromEl = document.getElementById("postmark-from");
        if (fromEl && !fromEl.value) fromEl.value = settings.fromEmail || "";
        var tokenEl = document.getElementById("postmark-token");
        if (tokenEl) tokenEl.placeholder = settings.hasPostmarkToken ? ("Stored: " + settings.maskedPostmarkToken + " — leave blank to keep") : "Enter your Postmark Server API token";
        var testEl = document.getElementById("email-test-to");
        if (testEl && !testEl.value) testEl.value = settings.updatedBy && settings.updatedBy.indexOf("@") >= 0 ? settings.updatedBy : "";
      } catch (error) { /* ignore */ }
      try {
        var data = await fetchJson("/api/admin/email-templates");
        emailTemplatesCache = data.templates || [];
        renderEmailGallery();
      } catch (error) {
        var g = document.getElementById("email-template-gallery");
        if (g) g.innerHTML = "<div class='empty-state'>Could not load templates.</div>";
      }
    }

    function renderEmailGallery() {
      var gallery = document.getElementById("email-template-gallery");
      if (!gallery) return;
      var byStage = {};
      var order = [];
      emailTemplatesCache.forEach(function (t) {
        if (!byStage[t.stage]) { byStage[t.stage] = []; order.push(t.stage); }
        byStage[t.stage].push(t);
      });
      gallery.innerHTML = order.map(function (stage) {
        var cards = byStage[stage].map(function (t) {
          return "<div class='email-tpl'>" +
            "<div class='email-tpl-head'>" +
              "<div class='email-tpl-meta'><strong>" + text(t.name) + "</strong><small>" + text(t.subject) + "</small></div>" +
              "<div class='email-tpl-actions'>" +
                "<button type='button' class='table-action' data-email-preview='" + t.key + "'>Preview</button>" +
                "<button type='button' class='table-action' data-email-test='" + t.key + "'>Send test</button>" +
              "</div>" +
            "</div>" +
            "<div class='email-tpl-preview' id='email-preview-" + t.key + "' hidden></div>" +
          "</div>";
        }).join("");
        return "<div class='email-stage'><p class='eyebrow'>" + text(stage) + "</p>" + cards + "</div>";
      }).join("");
    }

    async function saveEmailSettings(clearToken) {
      var status = document.getElementById("email-settings-status");
      var tokenEl = document.getElementById("postmark-token");
      var fromEl = document.getElementById("postmark-from");
      if (status) { status.textContent = "Saving…"; status.style.color = "#6a827d"; }
      try {
        await fetchJson("/api/admin/email-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            postmarkToken: clearToken ? "" : (tokenEl ? tokenEl.value.trim() : ""),
            clearPostmarkToken: Boolean(clearToken),
            fromEmail: fromEl ? fromEl.value.trim() : ""
          })
        });
        if (tokenEl) tokenEl.value = "";
        if (status) { status.textContent = clearToken ? "Token cleared." : "Saved."; status.style.color = "#0f6e56"; }
        loadEmailStudio();
      } catch (error) {
        if (status) { status.textContent = (error && error.error) || "Save failed."; status.style.color = "#b23a48"; }
      }
    }

    async function sendTemplateTest(key, button) {
      var status = document.getElementById("email-settings-status");
      var to = (document.getElementById("email-test-to") || {}).value || "";
      if (button) { button.disabled = true; button.textContent = "Sending…"; }
      try {
        var res = await fetchJson("/api/admin/email-templates/" + encodeURIComponent(key) + "/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: to })
        });
        if (status) {
          status.textContent = res.mode === "mock"
            ? "Provider not configured — send was simulated (add a Postmark token above)."
            : "Test sent to " + (res.to || to) + ".";
          status.style.color = res.mode === "mock" ? "#b7791f" : "#0f6e56";
        }
      } catch (error) {
        if (status) { status.textContent = (error && error.error) || "Test failed."; status.style.color = "#b23a48"; }
      } finally {
        if (button) { button.disabled = false; button.textContent = "Send test"; }
      }
    }

    function filteredFamilies() {
      var query = search.value.trim().toLowerCase();
      var status = statusFilter.value;
      var lockedOnly = lockedFilter ? lockedFilter.checked : false;
      var maxAiOnly = maxAiFilter ? maxAiFilter.checked : false;
      var subscription = subscriptionFilter ? subscriptionFilter.value : "all";
      var paidWindow = paidDateFilter ? paidDateFilter.value : "all";
      return readFamilies().filter(function (family) {
        // Deleted accounts live on the Deleted tab and never appear here.
        if (familyDeleted(family)) return false;
        // Accounts is the paying book: a family appears once it has actually been
        // charged. Trials (never charged) live on the Free Trial tab until they
        // convert, and pending signups are not customers yet.
        // Accounts = committed customers. That means anyone who has paid, plus a
      // Stripe card-upfront trial: they have a card on file and will be charged,
      // so they are a customer mid-trial — not a comped account. Without this
      // they would fall through both tabs and be invisible.
      if (!hasEverPaid(family) && !onStripeTrialFamily(family)) return false;
        var haystack = [family.parentName, family.email, family.studentName, family.grade, family.readingLevel, familyLoginType(family)].join(" ").toLowerCase();
        var matchesQuery = !query || haystack.indexOf(query) >= 0;
        var matchesStatus = status === "all" || family.subscriptionStatus === status;
        var matchesLocked = !lockedOnly || familyLocked(family);
        var matchesMaxAi = !maxAiOnly || familyMaxedAi(family);
        // Matches what the Subscription column shows: a trial counts as a trial
        // regardless of which plan it will bill onto.
        var onTrial = family.subscriptionStatus === "trial" || family.subscriptionStatus === "trialing";
        var interval = String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "yearly" : "monthly";
        var matchesSubscription = subscription === "all" ||
          (subscription === "trial" ? onTrial : !onTrial && interval === subscription);
        var matchesPaid = withinDateWindow(familyPaidAt(family), paidWindow);
        return matchesQuery && matchesStatus && matchesLocked && matchesMaxAi && matchesPaid && matchesSubscription;
      });
    }

    // Has this family ever actually been charged? A trial has paymentStatus
    // "trial" (then "unpaid" once it expires) and a pending signup "pending", so
    // neither counts. A refund still counts — money changed hands both ways.
    // A Stripe card-upfront trial: card captured, Stripe will bill at trial end.
    function onStripeTrialFamily(family) {
      return Boolean(family && family.subscriptionStatus === "trialing" && family.stripeSubscriptionId);
    }

    // The next date money moves for a family. For a live subscription that is the
    // period end; for a trial it is when billing starts, which is the whole point
    // of the forecast — those are the accounts about to convert or churn.
    function nextBillingDate(family) {
      if (!family) return "";
      if (family.subscriptionStatus === "trialing" || family.subscriptionStatus === "trial") {
        return family.trialEndsAt || "";
      }
      if (family.subscriptionStatus !== "active") return "";
      return (family.yearlyUpgrade && family.yearlyUpgrade.yearlyNextRenewalAt) ||
        family.currentPeriodEnd || family.nextRenewalAt || "";
    }

    // Cancel-scheduled accounts are deliberately excluded: they are not renewing,
    // they are ending, and the Cancellations tab already covers them.
    function upcomingRenewals(families) {
      var now = Date.now();
      var subscription = renewalSubscriptionFilter ? renewalSubscriptionFilter.value : "all";
      var window = renewalWindowFilter ? renewalWindowFilter.value : "30";
      var horizon = window === "all" ? Infinity : now + Number(window) * 86400000;
      return (families || []).reduce(function (rows, family) {
        if (familyDeleted(family) || family.accountLocked) return rows;
        var iso = nextBillingDate(family);
        if (!iso) return rows;
        var at = new Date(iso).getTime();
        if (!isFinite(at) || at < now || at > horizon) return rows;
        var onTrial = family.subscriptionStatus === "trial" || family.subscriptionStatus === "trialing";
        var interval = String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "yearly" : "monthly";
        if (subscription !== "all") {
          if (subscription === "trial" ? !onTrial : (onTrial || interval !== subscription)) return rows;
        }
        rows.push({
          family: family,
          at: at,
          iso: iso,
          days: Math.max(0, Math.ceil((at - now) / 86400000)),
          onTrial: onTrial,
          // A comped trial has no card, so nothing is collected when it ends.
          amountCents: (onTrial && !family.stripeSubscriptionId) ? 0 : planAmountCents(family.plan || moneyPlan())
        });
        return rows;
      }, []).sort(function (a, b) { return a.at - b.at; });
    }

    // Signed up but never converted: no payment, no trial of either kind, not
    // deleted. Accounts is paying-only and Free Trial is comped-only, so without
    // this view these families appear nowhere in the console at all.
    function isPendingSignup(family) {
      if (!family || familyDeleted(family)) return false;
      if (hasEverPaid(family) || onStripeTrialFamily(family)) return false;
      if (family.trialStartedAt || family.trialUsedAt) return false;
      return true;
    }

    function filteredSignups(families) {
      var query = signupSearch ? signupSearch.value.trim().toLowerCase() : "";
      var window = signupDateFilter ? signupDateFilter.value : "all";
      return (families || []).filter(function (family) {
        if (!isPendingSignup(family)) return false;
        var haystack = [family.parentName, family.email, family.studentName].join(" ").toLowerCase();
        if (query && haystack.indexOf(query) < 0) return false;
        return withinDateWindow(family.createdAt, window);
      }).sort(function (a, b) {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
    }

    function hasEverPaid(family) {
      if (!family) return false;
      if (family.lastPaymentAt) return true;
      if (["paid", "refunded", "partial_refunded"].indexOf(family.paymentStatus) >= 0) return true;
      return paymentsCache.some(function (payment) {
        return objectMatchesFamily(payment, family) && Number(payment.amountCents || 0) > 0;
      });
    }

    function paymentStatus(family) {
      return family.paymentStatus || (family.subscriptionStatus === "pending" ? "pending" : "paid");
    }

    function dateInRange(value, fromInput, toInput) {
      if (!fromInput && !toInput) return true;
      var timestamp = value ? new Date(value).getTime() : 0;
      if (!timestamp || !Number.isFinite(timestamp)) return !(fromInput && fromInput.value) && !(toInput && toInput.value);
      if (fromInput && fromInput.value) {
        var from = new Date(fromInput.value + "T00:00:00").getTime();
        if (timestamp < from) return false;
      }
      if (toInput && toInput.value) {
        var to = new Date(toInput.value + "T23:59:59").getTime();
        if (timestamp > to) return false;
      }
      return true;
    }

    function stripeUnixIso(value) {
      var seconds = Number(value || 0);
      return seconds ? new Date(seconds * 1000).toISOString() : "";
    }

    function filteredExceptions(families) {
      var query = exceptionSearch ? exceptionSearch.value.trim().toLowerCase() : "";
      var status = exceptionStatusFilter ? exceptionStatusFilter.value : "all";
      return families.filter(function (family) {
        var haystack = [family.parentName, family.email, family.studentName, family.plan, family.subscriptionStatus, family.paymentStatus].join(" ").toLowerCase();
        var matchesQuery = !query || haystack.indexOf(query) >= 0;
        var matchesStatus = status === "all" ||
          family.subscriptionStatus === status ||
          (status === "failed" && family.paymentStatus === "failed");
        return matchesQuery && matchesStatus;
      });
    }

    function escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }


    // Abuse alerts: families with signals newer than the operator's last dismissal.
    // The tile stays hidden at zero so a clean console isn't cluttered by it.
    function abuseFlagged(family) {
      var abuse = family && family.abuse;
      if (!abuse || !abuse.lastAt) return false;
      if (!abuse.dismissedAt) return true;
      return new Date(abuse.lastAt).getTime() > new Date(abuse.dismissedAt).getTime();
    }

    function renderAbuseTile(families) {
      var tile = document.getElementById("abuse-tile");
      if (!tile) return;
      var flagged = (families || []).filter(abuseFlagged);
      tile.hidden = flagged.length === 0;
      if (!flagged.length) return;
      setMetric("abuse-count", flagged.length);
      var totals = flagged.reduce(function (acc, family) {
        var abuse = family.abuse || {};
        acc.cap += Number(abuse.capHits || 0);
        acc.oversized += Number(abuse.oversized || 0);
        acc.moderation += Number(abuse.moderation || 0);
        return acc;
      }, { cap: 0, oversized: 0, moderation: 0 });
      var parts = [];
      if (totals.cap) parts.push(totals.cap + " over limit");
      if (totals.oversized) parts.push(totals.oversized + " oversized");
      if (totals.moderation) parts.push(totals.moderation + " flagged");
      var note = document.getElementById("abuse-note");
      if (note) note.textContent = parts.join(" · ") || "Accounts hitting limits";
    }

    async function dismissAbuseAlerts() {
      var button = document.getElementById("dismiss-abuse");
      if (button) button.disabled = true;
      try {
        var response = await apiFetch("/api/admin/abuse-alerts/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        if (!response.ok) throw new Error("Could not dismiss");
        await loadBackendState();
        renderAdmin();
      } catch (error) {
        var note = document.getElementById("abuse-note");
        if (note) note.textContent = "Could not dismiss — try again.";
      } finally {
        if (button) button.disabled = false;
      }
    }

    function setMetric(id, value) {
      var element = document.getElementById(id);
      if (element) element.textContent = String(value);
    }

    function planAmount(plan) {
      var pricing = readPricing();
      return plan === "Family Yearly" ? "$" + pricing.yearly.amount : "$" + pricing.monthly.amount;
    }

    function planNumericAmount(plan) {
      var pricing = readPricing();
      return plan === "Family Yearly" ? Number(pricing.yearly.amount) : Number(pricing.monthly.amount);
    }

    function planAmountCents(plan) {
      return Math.round(planNumericAmount(plan) * 100);
    }

    function moneyFromCents(amountCents) {
      var amount = Number(amountCents || 0) / 100;
      return "$" + amount.toFixed(amount % 1 === 0 ? 0 : 2);
    }

    function cleanStripeSuffix(value) {
      return String(value || "family").replace(/[^a-z0-9_]/gi, "_");
    }

    function stripePaymentId(family) {
      return family.stripePaymentId || "pi_mock_" + cleanStripeSuffix(family.id || family.email);
    }

    function latestPaymentForFamily(family) {
      return paymentsCache
        .filter(function (payment) { return objectMatchesFamily(payment, family) && Number(payment.amountCents || 0) > 0; })
        .sort(function (a, b) { return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); })[0] || null;
    }

    function familyForPayment(payment, families) {
      return families.find(function (family) {
        return (payment.familyId && family.id === payment.familyId) ||
          (payment.email && normalizeEmail(family.email) === normalizeEmail(payment.email));
      }) || null;
    }

    function planForPayment(payment, family) {
      var upgrade = family?.yearlyUpgrade || {};
      var monthlyIds = Array.isArray(upgrade.monthlySubscriptionIds) ? upgrade.monthlySubscriptionIds : [];
      if (payment.subscriptionId && monthlyIds.includes(payment.subscriptionId)) return "Family Monthly";
      if (payment.subscriptionId && payment.subscriptionId === upgrade.yearlySubscriptionId) return "Family Yearly";
      return family?.plan || moneyPlan();
    }

    function filteredPaymentRecords(families) {
      var query = paymentSearch ? paymentSearch.value.trim().toLowerCase() : "";
      var status = paymentStatusFilter ? paymentStatusFilter.value : "all";
      var planFilter = paymentPlanFilter ? paymentPlanFilter.value : "all";
      // Only real payments. This used to synthesise a row per family whenever
      // there were no payment records, inventing a "pi_mock_..." reference and
      // using the plan's list price as the amount — so trials and pending
      // signups appeared as charges that never happened. Billing now shows an
      // empty state until Stripe actually writes a payment.
      var records = paymentsCache.filter(function (payment) { return Number(payment.amountCents || 0) > 0; });
      return records.map(function (payment) {
        var family = familyForPayment(payment, families);
        return {
          family: family,
          payment: payment,
          plan: planForPayment(payment, family)
        };
      }).filter(function (row) {
        var family = row.family || {};
        var payment = row.payment || {};
        var haystack = [family.parentName, family.email, family.studentName, row.plan, payment.paymentId, payment.email].join(" ").toLowerCase();
        var matchesQuery = !query || haystack.indexOf(query) >= 0;
        var matchesStatus = status === "all" || payment.status === status || family.subscriptionStatus === status;
        var matchesPlan = planFilter === "all" || row.plan === planFilter;
        var matchesDate = dateInRange(payment.createdAt, paymentFrom, paymentTo);
        return matchesQuery && matchesStatus && matchesPlan && matchesDate;
      }).sort(function (a, b) {
        return new Date(b.payment.createdAt || 0) - new Date(a.payment.createdAt || 0);
      });
    }

    function stripeSubscriptionId(family) {
      return family.stripeSubscriptionId || "sub_mock_" + cleanStripeSuffix(family.id || family.email);
    }

    function stripePaymentUrl(paymentId) {
      if (String(paymentId || "").startsWith("cs_")) return "https://dashboard.stripe.com/test/checkout/sessions/" + encodeURIComponent(paymentId);
      if (String(paymentId || "").startsWith("in_")) return "https://dashboard.stripe.com/test/invoices/" + encodeURIComponent(paymentId);
      return "https://dashboard.stripe.com/test/payments/" + encodeURIComponent(paymentId);
    }

    function familyRowId(family) {
      return family.id || cleanStripeSuffix(family.email || family.parentName);
    }

    function familyLocked(family) {
      return Boolean(family.accountLocked);
    }

    function familyDeleted(family) {
      return Boolean(family.anonymizedAt || family.deletionCompletedAt || family.subscriptionStatus === "deleted");
    }

    function familySubscriptionActive(family) {
      return family.subscriptionStatus === "active" || family.subscriptionStatus === "cancel_scheduled";
    }

    function billingExceptions(family) {
      return Array.isArray(family.billingExceptions) ? family.billingExceptions : [];
    }

    function exceptionStatusText(family) {
      var parts = [];
      if (family.billingCreditCents) parts.push("$" + Math.round(Number(family.billingCreditCents) / 100) + " credit");
      if (family.entitlementOverrideUntil) parts.push("Access until " + rowDateTime(family.entitlementOverrideUntil));
      if (billingExceptions(family).length) parts.push(billingExceptions(family).length + " case" + (billingExceptions(family).length === 1 ? "" : "s"));
      if (family.retentionOffer && family.retentionOffer.status === "accepted") parts.push("Save discount");
      if (family.yearlyUpgrade && family.yearlyUpgrade.status === "scheduled") parts.push("Yearly upgrade");
      return parts.length ? parts.join(" · ") : "No exceptions";
    }

    function recommendedException(family) {
      if (family.paymentStatus === "failed") return "7-day access + retry email";
      if (family.subscriptionStatus === "cancelled") return "50% winback + email";
      if (family.subscriptionStatus === "paused") return "Extend access + restart date";
      if (family.paymentStatus === "partial_refunded" || family.paymentStatus === "refunded") return "Follow up after refund";
      if (daysSinceActivity(family) > 10) return "Free month + study goal";
      return "Keep healthy";
    }

    function exceptionActionLabel(action) {
      return {
        partial_refund: "custom refund",
        credit_next_invoice: "invoice credit",
        add_free_months: "free months",
        apply_discount: "next bill discount",
        extend_access: "access extension",
        pause_billing: "billing pause",
        cancel_period_end: "cancellation at period end",
        send_save_email: "save email"
      }[action] || "billing exception";
    }

    function exceptionEmailFor(action, family) {
      var firstName = text(family && family.parentName).split(" ")[0] || "there";
      var amount = exceptionAmount ? Number(exceptionAmount.value || 0).toFixed(2) : "10.00";
      var months = exceptionMonths ? Number(exceptionMonths.value || 1) : 1;
      var days = exceptionDays ? Number(exceptionDays.value || 14) : 14;
      var percent = exceptionPercent ? Number(exceptionPercent.value || 50) : 50;
      if (action === "partial_refund") return "Hi " + firstName + ", I issued a $" + amount + " refund for your KiddieGPT account. Thanks for giving us the chance to make this right.";
      if (action === "credit_next_invoice") return "Hi " + firstName + ", I added a $" + amount + " credit to your next KiddieGPT invoice. Your child can keep using the learning tools as usual.";
      if (action === "add_free_months") return "Hi " + firstName + ", I added " + months + " free month" + (months === 1 ? "" : "s") + " to your KiddieGPT account as a make-good. I appreciate your patience.";
      if (action === "apply_discount") return "Hi " + firstName + ", I applied " + percent + "% off your next KiddieGPT bill. No code is needed; it is handled automatically.";
      if (action === "extend_access") return "Hi " + firstName + ", I extended KiddieGPT access for " + days + " days so your child can retry the tools before any billing decision.";
      if (action === "pause_billing") return "Hi " + firstName + ", I paused KiddieGPT billing for your family. Access and billing status are now updated on our side.";
      if (action === "cancel_period_end") return "Hi " + firstName + ", I scheduled your KiddieGPT subscription to cancel at the end of the paid period. Your child keeps access until then.";
      return "Hi " + firstName + ", I made a KiddieGPT account adjustment for your family. Thanks for giving us the chance to help.";
    }

    function syncExceptionAdjustmentFields(action) {
      var amountField = document.getElementById("exception-amount-field");
      var monthsField = document.getElementById("exception-months-field");
      var percentField = document.getElementById("exception-percent-field");
      var daysField = document.getElementById("exception-days-field");
      var showAmount = ["partial_refund", "credit_next_invoice"].includes(action);
      var showMonths = action === "add_free_months";
      var showPercent = action === "apply_discount";
      var showDays = action === "extend_access";
      if (amountField) amountField.hidden = !showAmount;
      if (monthsField) monthsField.hidden = !showMonths;
      if (percentField) percentField.hidden = !showPercent;
      if (daysField) daysField.hidden = !showDays;
      var conditionalFields = document.querySelector(".exception-conditional-fields");
      if (conditionalFields) conditionalFields.classList.toggle("is-empty", !(showAmount || showMonths || showPercent || showDays));
    }

    function selectedExceptionFamily() {
      var id = exceptionFamilySelect ? exceptionFamilySelect.value : selectedExceptionFamilyId;
      if (exceptionFamilySelect && !id) return null;
      return familyById(id) || readFamilies()[0] || null;
    }

    function populateExceptionFamilies() {
      if (!exceptionFamilySelect) return;
      var query = exceptionParentSearch ? exceptionParentSearch.value.trim().toLowerCase() : "";
      var families = readFamilies().filter(function (family) {
        var haystack = [family.parentName, family.email, family.studentName, family.plan].join(" ").toLowerCase();
        return !query || haystack.indexOf(query) >= 0;
      }).slice(0, 60);
      var previous = exceptionFamilySelect.value || selectedExceptionFamilyId;
      exceptionFamilySelect.innerHTML = families.map(function (family) {
        return "<option value='" + familyRowId(family) + "'>" + escapeHtml(family.parentName) + " · " + escapeHtml(family.email) + " · " + escapeHtml(family.plan || moneyPlan()) + "</option>";
      }).join("");
      if (previous && families.some(function (family) { return familyRowId(family) === previous; })) {
        exceptionFamilySelect.value = previous;
      }
      selectedExceptionFamilyId = exceptionFamilySelect.value || "";
    }

    function familyDuplicateSubscriptionIds(family) {
      var ids = []
        .concat(Array.isArray(family.stripeDuplicateSubscriptionIds) ? family.stripeDuplicateSubscriptionIds : [])
        .concat(family.retentionOffer && Array.isArray(family.retentionOffer.duplicateSubscriptionIds) ? family.retentionOffer.duplicateSubscriptionIds : [])
        .concat(family.yearlyUpgrade && Array.isArray(family.yearlyUpgrade.previousMonthlySubscriptionIds) ? family.yearlyUpgrade.previousMonthlySubscriptionIds : []);
      return ids.filter(function (id, index) {
        return id && ids.indexOf(id) === index && id !== family.stripeSubscriptionId;
      });
    }

    function familyMatchKeys(family) {
      return [familyRowId(family), family.email, family.parentName, family.studentName, family.stripeCustomerId, family.stripeSubscriptionId]
        .concat(familyDuplicateSubscriptionIds(family))
        .filter(Boolean)
        .map(function (value) { return String(value).toLowerCase(); });
    }

    function payloadSummary(payload) {
      if (!payload || typeof payload !== "object") return "-";
      return Object.keys(payload).slice(0, 6).map(function (key) {
        var value = payload[key];
        if (Array.isArray(value)) value = value.join(", ");
        else if (value && typeof value === "object") value = JSON.stringify(value);
        return key + ": " + text(value);
      }).join(" · ") || "-";
    }

    function objectMatchesFamily(value, family) {
      var haystack = JSON.stringify(value || {}).toLowerCase();
      return familyMatchKeys(family).some(function (key) {
        return key && haystack.indexOf(key) >= 0;
      });
    }

    function selectedFamilyTimeline(family) {
      var timeline = [];
      auditLogsCache.forEach(function (log) {
        if (!objectMatchesFamily(log, family)) return;
        timeline.push({
          kind: logCategory(log),
          date: log.createdAt,
          title: text(log.action).replace(/_/g, " "),
          detail: payloadSummary(log.payload),
          actor: logActor(log)
        });
      });
      emailLogsCache.forEach(function (log) {
        if (!objectMatchesFamily(log, family)) return;
        timeline.push({
          kind: "email",
          date: log.createdAt,
          title: text(log.template || log.subject || "Email sent"),
          detail: "to: " + text(log.to || family.email) + " · status: " + text(log.status || "sent"),
          actor: "system"
        });
      });
      paymentsCache.forEach(function (payment) {
        if (!objectMatchesFamily(payment, family)) return;
        timeline.push({
          kind: "payment",
          date: payment.createdAt,
          title: text(payment.status || payment.type || "payment"),
          detail: "$" + (Number(payment.amountCents || 0) / 100).toFixed(2) + " · " + text(payment.paymentId || payment.id),
          actor: text(payment.email || family.email)
        });
      });
      billingExceptions(family).forEach(function (item) {
        timeline.push({
          kind: "exception",
          date: item.createdAt || item.appliedAt || item.until || family.updatedAt,
          title: exceptionActionLabel(item.action || item.type || "billing_exception"),
          detail: payloadSummary(item),
          actor: "admin"
        });
      });
      return timeline.sort(function (a, b) {
        return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
      });
    }

    function renderExceptionContext() {
      if (!exceptionContext) return;
      var family = selectedExceptionFamily();
      if (!family) {
        if (exceptionContextState) {
          exceptionContextState.textContent = "Select parent";
          exceptionContextState.className = "state-chip warning";
        }
        exceptionContext.innerHTML =
          "<div class='exception-empty'><strong>Select a parent</strong><small>Duplicate subscriptions, exceptions, payments, emails, and audit logs will appear here before you apply an action.</small></div>";
        return;
      }
      var duplicateIds = familyDuplicateSubscriptionIds(family);
      var timeline = selectedFamilyTimeline(family);
      var duplicateText = duplicateIds.length
        ? duplicateIds.map(escapeHtml).join("<br>")
        : "No duplicate Stripe subscription IDs recorded.";
      var duplicateClass = duplicateIds.length ? "needs-review" : "clear";
      if (exceptionContextState) {
        exceptionContextState.textContent = duplicateIds.length ? "Review duplicates" : "Ready";
        exceptionContextState.className = "state-chip " + (duplicateIds.length ? "warning" : "ready");
      }
      var timelineMarkup = timeline.length ? timeline.map(function (item) {
        return "<div class='exception-log-row'>" +
          "<span>" + rowDateTime(item.date) + "</span>" +
          "<strong>" + escapeHtml(item.title) + "</strong>" +
          "<small>" + escapeHtml(item.kind) + " · " + escapeHtml(item.actor) + "</small>" +
          "<p>" + escapeHtml(item.detail) + "</p>" +
        "</div>";
      }).join("") : "<div class='exception-empty compact'><strong>No matched logs yet</strong><small>This parent has no matching audit, payment, email, or exception records in the current admin cache.</small></div>";
      exceptionContext.innerHTML =
        "<div class='exception-context-grid'>" +
          "<div class='exception-context-cardlet'>" +
            "<span>Parent</span><strong>" + escapeHtml(text(family.parentName)) + "</strong><small>" + escapeHtml(text(family.email)) + "</small>" +
          "</div>" +
          "<div class='exception-context-cardlet'>" +
            "<span>Plan</span><strong>" + escapeHtml(text(family.plan || moneyPlan())) + "</strong><small>" + escapeHtml(text(family.subscriptionStatus)) + " · " + escapeHtml(text(paymentStatus(family))) + "</small>" +
          "</div>" +
          "<div class='exception-context-cardlet'>" +
            "<span>Student</span><strong>" + escapeHtml(text(family.studentName)) + "</strong><small>" + escapeHtml(text(family.grade)) + " · " + escapeHtml(text(family.readingLevel)) + "</small>" +
          "</div>" +
        "</div>" +
        "<div class='exception-duplicate " + duplicateClass + "'>" +
          "<i data-lucide='" + (duplicateIds.length ? "triangle-alert" : "badge-check") + "'></i>" +
          "<div><strong>" + (duplicateIds.length ? "Duplicate subscription check" : "Duplicate check clear") + "</strong>" +
          "<small>" + duplicateText + "</small>" +
          "<p>" + (duplicateIds.length ? "Verify the active Stripe subscription, cancel the duplicate at period end, then choose a refund, credit, or save email." : "No duplicate billing signal is attached to this parent right now.") + "</p></div>" +
        "</div>" +
        "<div class='exception-log-head'><strong>All user logs</strong><span>" + timeline.length + " matched</span></div>" +
        "<div class='exception-log-list'>" + timelineMarkup + "</div>";
      renderIcons();
    }

    function refreshExceptionComposer() {
      if (!exceptionActionSelect || !exceptionEmailMessage) return;
      var family = selectedExceptionFamily();
      var action = exceptionActionSelect.value;
      syncExceptionAdjustmentFields(action);
      if (exceptionReason) exceptionReason.value = exceptionReason.value || "Admin save desk";
      exceptionEmailMessage.value = exceptionEmailFor(action, family || {});
      if (exceptionActionState) {
        exceptionActionState.textContent = family ? "Ready" : "Select parent";
        exceptionActionState.className = "state-chip " + (family ? "ready" : "warning");
      }
      renderExceptionContext();
    }

    function exceptionPayloadFromForm() {
      var family = selectedExceptionFamily();
      if (!family) throw new Error("Select a parent first.");
      var action = exceptionActionSelect.value;
      var amountCents = Math.round(Number(exceptionAmount.value || 0) * 100);
      var payload = {
        action: action,
        familyId: familyRowId(family),
        email: family.email,
        reason: exceptionReason ? exceptionReason.value.trim() || "Admin save desk" : "Admin save desk",
        message: exceptionEmailMessage ? exceptionEmailMessage.value : ""
      };
      if (action === "partial_refund") {
        payload.paymentIntentId = stripePaymentId(family);
        payload.amountCents = Math.max(1, amountCents || 1000);
      }
      if (action === "credit_next_invoice") payload.creditCents = Math.max(1, amountCents || 1500);
      if (action === "add_free_months") payload.months = Math.max(1, Number(exceptionMonths.value || 1));
      if (action === "apply_discount") payload.percentOff = Math.min(100, Math.max(1, Number(exceptionPercent.value || 50)));
      if (action === "extend_access") payload.days = Math.max(1, Number(exceptionDays.value || 14));
      return payload;
    }

    function logCategory(log) {
      var action = String(log.action || "");
      if (action.indexOf("billing") >= 0 || action.indexOf("refund") >= 0 || action.indexOf("subscription") >= 0 || action.indexOf("retention") >= 0) return "billing";
      if (action.indexOf("email") >= 0) return "email";
      if (action.indexOf("stripe") >= 0 || action.indexOf("checkout") >= 0) return "stripe";
      if (action.indexOf("account") >= 0 || action.indexOf("family") >= 0 || action.indexOf("user") >= 0) return "account";
      return "system";
    }

    function logActor(log) {
      return log.actor || log.payload && (log.payload.adminEmail || log.payload.actor || log.payload.email || log.payload.parentEmail) || "system";
    }

    function logEmail(log) {
      return log.payload && (log.payload.email || log.payload.parentEmail || log.payload.to) || "";
    }

    function logDetail(log) {
      var payload = log.payload || {};
      return Object.keys(payload).slice(0, 5).map(function (key) {
        return key + ": " + text(payload[key]);
      }).join(" · ") || "-";
    }

    function filteredLogs() {
      var query = logSearch ? logSearch.value.trim().toLowerCase() : "";
      var type = logTypeFilter ? logTypeFilter.value : "all";
      return auditLogsCache.filter(function (log) {
        var category = logCategory(log);
        var haystack = [log.action, logActor(log), logEmail(log), logDetail(log), category].join(" ").toLowerCase();
        return (type === "all" || category === type) && (!query || haystack.indexOf(query) >= 0);
      });
    }

    function familyLoginType(family) {
      // Name the credential actually used. "Parent" was the old catch-all.
      var type = family.loginType || "";
      if (type === "Google") return "Google";
      if (type === "Deleted") return "Deleted";
      return "Email";
    }

    // Subscription column: a trial shows its length rather than a billing interval.
    function familySubscriptionLabel(family) {
      if (family.subscriptionStatus === "trialing") {
        var interval = String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "Yearly" : "Monthly";
        return interval + " (trial)";
      }
      if (family.subscriptionStatus === "trial" || (family.trialStartedAt && !family.lastPaymentAt)) {
        var days = Number(family.trialDays) || 0;
        return days ? days + " days" : "Trial";
      }
      return String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "Yearly" : "Monthly";
    }

    // Accounts that have tripped the account-level AI token ceiling.
    function familyMaxedAi(family) {
      return Number((family.abuse || {}).capHits || 0) > 0;
    }

    // Shortcut date windows shared by the paid-date and deleted-date filters.
    function withinDateWindow(value, mode) {
      if (!mode || mode === "all") return true;
      var time = value ? new Date(value).getTime() : 0;
      if (!time || !Number.isFinite(time)) return false;
      var now = new Date();
      if (mode === "ytd") return time >= new Date(now.getFullYear(), 0, 1).getTime();
      if (mode === "week") {
        var start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - start.getDay());
        return time >= start.getTime();
      }
      var days = Number(mode) || 0;
      return days ? time >= Date.now() - days * 86400000 : true;
    }

    // Date a family last paid — what the paid-date shortcut filters on.
    function familyPaidAt(family) {
      return family.lastPaymentAt || family.trialStartedAt || family.createdAt || "";
    }

    function familyById(familyId) {
      return readFamilies().find(function (family) {
        return familyRowId(family) === familyId;
      });
    }

    function updateFamilyRecord(familyId, updater) {
      var families = readFamilies().map(function (family) {
        if (familyRowId(family) !== familyId) return family;
        var next = Object.assign({}, family);
        if (!next.id) next.id = familyId;
        updater(next);
        return next;
      });
      writeFamilies(families);
    }

    function childrenOf(family) {
      return family.children && family.children.length ? family.children : [family];
    }

    function normaliseFamilies(families) {
      var changed = false;
      var normalised = families.map(function (family, index) {
        var next = Object.assign({}, family);
        if (next.accountLocked == null) {
          next.accountLocked = next.subscriptionStatus === "cancelled";
          changed = true;
        }
        if (!next.loginType) {
          next.loginType = "Parent";
          changed = true;
        }
        if (!next.lastLoginAt) {
          next.lastLoginAt = new Date(Date.now() - (index + 1) * 3600000 - daysSinceActivity(next) * 86400000).toISOString();
          changed = true;
        }
        if (!next.lastExtensionUseAt) {
          next.lastExtensionUseAt = new Date(Date.now() - daysSinceActivity(next) * 86400000 - (index + 1) * 1800000).toISOString();
          changed = true;
        }
        return next;
      });
      if (changed) writeFamilies(normalised);
      return normalised;
    }

    function daysSinceActivity(family) {
      var lastUse = childrenOf(family).reduce(function (latest, child) {
        var seen = child.usage && child.usage.lastExtensionUseAt ? new Date(child.usage.lastExtensionUseAt).getTime() : 0;
        return Math.max(latest, seen);
      }, 0);
      if (lastUse) return Math.max(0, Math.round((Date.now() - lastUse) / 86400000));
      if (family.lastActivityDays != null) return Number(family.lastActivityDays);
      var created = family.createdAt ? new Date(family.createdAt).getTime() : Date.now();
      return Math.max(0, Math.round((Date.now() - created) / 86400000));
    }

    function usageToday(child) {
      var today = new Date().toISOString().slice(0, 10);
      var bucket = (child && child.usage && child.usage.daily && child.usage.daily[today]) || {};
      return { math: Number(bucket.mathProblems || 0), voiceMin: Math.round(Number(bucket.voiceSeconds || 0) / 60) };
    }

    function shortDate(value) {
      if (!value && value !== 0) return "—";
      var d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
      if (isNaN(d.getTime())) return "—";
      // Consistent m/d/yy across all tables.
      return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
    }

    // Next renewal / period-end for the families table.
    function familyNextRenewal(family) {
      var status = family.subscriptionStatus;
      if (status === "cancelled" || status === "deleted") return "Ended";
      if (status === "cancel_scheduled") {
        var until = family.cancelAccessUntil || family.cancellationAccessUntil;
        return until ? "Ends " + shortDate(until) : "Ending";
      }
      if (status !== "active") return "—";
      var explicit = (family.yearlyUpgrade && family.yearlyUpgrade.yearlyNextRenewalAt) || family.currentPeriodEnd || family.nextRenewalAt;
      if (explicit) return shortDate(explicit);
      var isYearly = String(family.plan || "").toLowerCase().indexOf("year") >= 0;
      var base = family.lastPaymentAt || family.createdAt;
      if (!base) return "—";
      var d = new Date(base);
      if (isNaN(d.getTime())) return "—";
      var advance = function () { if (isYearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); };
      advance();
      while (d.getTime() <= Date.now()) advance();
      return "~" + shortDate(d.toISOString());
    }

    function favoriteTool(family, index) {
      var tools = ["Math Step Tutor", "PDF Explainer", "Flashcards", "Reading Coach", "Graph Helper", "Quiz Builder"];
      return family.favoriteTool || tools[index % tools.length];
    }

    function familyHealth(family) {
      if (family.subscriptionStatus === "cancelled") return { label: "Winback", status: "error", score: 22 };
      if (family.subscriptionStatus === "paused") return { label: "Paused", status: "paused", score: 48 };
      if (family.paymentStatus === "failed") return { label: "Payment risk", status: "pending", score: 42 };
      if (daysSinceActivity(family) > 10) return { label: "Inactive", status: "pending", score: 55 };
      if (family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded") return { label: "Refund review", status: family.paymentStatus, score: 68 };
      if (family.subscriptionStatus === "pending") return { label: "Onboarding", status: "pending", score: 60 };
      return { label: "Healthy", status: "active", score: 88 };
    }

    function nextStep(family) {
      if (family.paymentStatus === "failed") return "Send payment retry";
      if (family.subscriptionStatus === "pending") return "Nudge onboarding";
      if (family.subscriptionStatus === "paused") return "Schedule restart";
      if (family.subscriptionStatus === "cancelled") return "Send winback";
      if (family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded") return "Check billing note";
      if (daysSinceActivity(family) > 10) return "Send usage tip";
      return "Monitor";
    }

    function familyRisk(family) {
      var health = familyHealth(family);
      var issueCount = reconciliationIssues(family).length;
      if (issueCount) return { label: issueCount + " billing " + (issueCount === 1 ? "check" : "checks"), status: "error" };
      return { label: health.label, status: health.status };
    }

    function familyNextAction(family) {
      var step = nextStep(family);
      var detail = {
        "Send payment retry": "Payment needs recovery",
        "Nudge onboarding": "Checkout or setup is unfinished",
        "Schedule restart": "Subscription is paused",
        "Send winback": "Subscription has ended",
        "Check billing note": "Refund needs a follow-up",
        "Send usage tip": "No extension activity in 10+ days",
        "Monitor": "No urgent action"
      }[step] || "Review customer timeline";
      return { label: step, detail: detail };
    }

    function reconciliationIssues(family) {
      var issues = [];
      if (!family) return issues;
      if ((family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded") && familySubscriptionActive(family)) {
        issues.push("Refunded payment with active access");
      }
      if (familyDeleted(family) && (family.stripeSubscriptionId || family.subscriptionStatus === "active")) {
        issues.push("Deleted account still has billing reference");
      }
      if (familyDuplicateSubscriptionIds(family).length) issues.push("Duplicate Stripe subscription");
      if (family.subscriptionStatus === "active" && family.paymentStatus === "failed") issues.push("Active account with failed payment");
      if (family.subscriptionStatus === "pending" && hasEverPaid(family)) issues.push("Payment recorded but account is pending");
      return issues;
    }

    function reconciliationIssuesForFamilies(families) {
      return (families || []).reduce(function (total, family) {
        return total + reconciliationIssues(family).length;
      }, 0);
    }

    function adminActions(families) {
      var actions = [];
      families.forEach(function (family) {
        var rowId = familyRowId(family);
        if (family.paymentStatus === "failed") {
          actions.push({ priority: "High", icon: "credit-card", title: "Retry failed payment", detail: family.parentName + " needs a payment recovery email.", action: "Payment retry", familyId: rowId });
        }
        if (family.subscriptionStatus === "pending") {
          actions.push({ priority: "High", icon: "user-check", title: "Finish parent onboarding", detail: family.parentName + " has not fully activated extension access.", action: "Onboarding nudge", familyId: rowId });
        }
        if (daysSinceActivity(family) > 10 && family.subscriptionStatus === "active") {
          actions.push({ priority: "Medium", icon: "activity", title: "Recover inactive student", detail: family.studentName + " has been quiet for " + daysSinceActivity(family) + " days.", action: "Usage tip", familyId: rowId });
        }
        if (family.subscriptionStatus === "paused") {
          actions.push({ priority: "Medium", icon: "pause-circle", title: "Restart paused subscription", detail: family.parentName + " is paused and ready for a restart reminder.", action: "Restart reminder", familyId: rowId });
        }
        if (family.subscriptionStatus === "cancelled") {
          actions.push({ priority: "Low", icon: "heart-handshake", title: "Send winback offer", detail: family.parentName + " cancelled after low usage.", action: "Winback offer", familyId: rowId });
        }
      });
      return actions;
    }

    function actionItemMarkup(item) {
      return "<div class='action-item'>" +
        "<span class='action-icon'><i data-lucide='" + item.icon + "'></i></span>" +
        "<div><strong>" + item.title + "</strong><small>" + item.detail + "</small></div>" +
        "<span class='priority-pill " + item.priority.toLowerCase() + "'>" + item.priority + "</span>" +
      "</div>";
    }

    function renderMarkup(id, markup) {
      var node = document.getElementById(id);
      if (node) node.innerHTML = markup;
    }

    function ruleMarkup(title, detail, status, icon) {
      return "<div class='rule-item'>" +
        "<i data-lucide='" + (icon || "check-circle-2") + "'></i>" +
        "<div><strong>" + title + "</strong><small>" + detail + "</small></div>" +
        "<span class='state-chip " + (status || "active") + "'>" + (status || "ready") + "</span>" +
      "</div>";
    }

    function percent(value, total) {
      return total ? Math.round((value / total) * 100) + "%" : "0%";
    }

    function money(value) {
      return "$" + Math.round(value);
    }

    function paymentEmailTemplates(family) {
      return {
        receipt: "Hi " + text(family.parentName).split(" ")[0] + ", your KiddieGPT payment is complete. Your child can keep using all learning tools today.",
        retry: "Hi " + text(family.parentName).split(" ")[0] + ", your KiddieGPT payment did not go through. Please update your card so your child keeps access to the learning tools.",
        refund: "Hi " + text(family.parentName).split(" ")[0] + ", I issued the refund for this KiddieGPT payment. You should see it on your original payment method after Stripe finishes processing it.",
        save: "Hi " + text(family.parentName).split(" ")[0] + ", before you leave KiddieGPT, I can help set up a simple weekly goal and reward plan for " + text(family.studentName) + "."
      };
    }

    function paymentDetailRow(family, action, paymentId, amountCents) {
      var templates = paymentEmailTemplates(family);
      var selected = action === "refund" ? templates.refund : paymentStatus(family) === "failed" ? templates.retry : templates.receipt;
      return "<tr class='payment-detail-row'><td colspan='8'>" +
        "<div class='payment-detail-panel'>" +
          "<div class='payment-detail-head'><div><span>" + (action === "refund" ? "Refund workflow" : "Email workflow") + "</span><strong>" + escapeHtml(family.parentName) + "</strong><small>" + escapeHtml(family.email) + " · " + escapeHtml(paymentId) + "</small></div>" +
          "<button type='button' class='table-action' data-payment-close>Close</button></div>" +
          "<div class='payment-action-grid'>" +
            "<section><h3>Email shortcuts</h3><div class='template-button-row'>" +
              "<button type='button' class='table-action' data-payment-template='receipt' data-family-id='" + familyRowId(family) + "'>Receipt</button>" +
              "<button type='button' class='table-action' data-payment-template='retry' data-family-id='" + familyRowId(family) + "'>Retry</button>" +
              "<button type='button' class='table-action' data-payment-template='refund' data-family-id='" + familyRowId(family) + "'>Refund note</button>" +
              "<button type='button' class='table-action' data-payment-template='save' data-family-id='" + familyRowId(family) + "'>Save offer</button>" +
            "</div><label>Compose email<textarea data-payment-compose='" + familyRowId(family) + "' rows='5'>" + escapeHtml(selected) + "</textarea></label>" +
            "<button type='button' class='button primary' data-payment-send data-family-id='" + familyRowId(family) + "'>Send email</button></section>" +
            "<section class='refund-confirm-box'><h3>Refund</h3><p>This will create a refund for " + moneyFromCents(amountCents) + " on payment " + escapeHtml(paymentId) + ".</p>" +
            "<label>Pre-written refund email<textarea data-refund-note='" + familyRowId(family) + "' rows='5'>" + escapeHtml(templates.refund) + "</textarea></label>" +
            "<button type='button' class='button danger' data-payment-action='refund' data-family-id='" + familyRowId(family) + "' data-payment-id='" + paymentId + "' data-amount-cents='" + amountCents + "'>Issue refund and log email</button></section>" +
          "</div>" +
        "</div>" +
      "</td></tr>";
    }

    function nextDeletedEmailPreview() {
      return "deleted_user_" + String(Number(deletedUserSequence || 0) + 1).padStart(5, "0");
    }

    function deletionRequests(families) {
      return families.filter(function (family) {
        return family.deletionRequestedAt || family.anonymizedAt || family.deletionCompletedAt || family.subscriptionStatus === "deleted";
      }).sort(function (a, b) {
        return new Date(b.deletionRequestedAt || b.anonymizedAt || b.createdAt || 0).getTime() -
          new Date(a.deletionRequestedAt || a.anonymizedAt || a.createdAt || 0).getTime();
      });
    }

    function deletionStatus(family) {
      if (family.anonymizedAt || family.deletionCompletedAt || family.subscriptionStatus === "deleted") return "anonymized";
      if (family.deletionRequestedAt) return "requested";
      return "none";
    }

    function goalCount(family) {
      return (family.children || []).reduce(function (total, child) {
        return total + ((child.learningGoals && child.learningGoals.length) || (child.goal ? 1 : 0));
      }, 0);
    }

    function statusChip(status) {
      return "<span class='state-chip " + text(status) + "'>" + text(status).replace(/_/g, " ") + "</span>";
    }

    function rowDate(family, offset) {
      var base = family.createdAt ? new Date(family.createdAt) : new Date();
      base.setDate(base.getDate() + (offset || 0));
      return base.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
    }

    function rowDateTime(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString([], {
        month: "numeric",
        day: "numeric",
        year: "2-digit",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function stripeUnixDateTime(value) {
      var seconds = Number(value || 0);
      return seconds ? rowDateTime(new Date(seconds * 1000).toISOString()) : "-";
    }

    // ---- Sortable tables ------------------------------------------------------
    // Every admin table renders through renderRows(), so sorting is wired once
    // here rather than per table. Sort state is kept per tbody id and re-applied
    // after each render, otherwise any refresh would silently reset the order.
    var tableSortState = {};

    // Compare cells as numbers or dates where they look like one, else text — so
    // "Maxed ×2", "$38" and "7/19/26" sort sensibly instead of alphabetically.
    function sortCellValue(cell) {
      var raw = (cell.textContent || "").trim();
      if (!raw || raw === "—" || raw === "-") return { type: "empty", value: "" };
      var numeric = raw.replace(/[$,%×x]/gi, "").replace(/,/g, "").trim();
      if (numeric && !isNaN(Number(numeric))) return { type: "number", value: Number(numeric) };
      var parsed = Date.parse(raw);
      if (!isNaN(parsed) && /\d/.test(raw) && /[\/\-:]/.test(raw)) return { type: "number", value: parsed };
      return { type: "text", value: raw.toLowerCase() };
    }

    function applyTableSort(bodyId) {
      var state = tableSortState[bodyId];
      var body = document.getElementById(bodyId);
      if (!state || !body || !body.children.length) return;
      if (body.querySelector(".empty-state")) return;
      // Keep each expandable row glued to its detail row.
      var groups = [];
      Array.prototype.forEach.call(body.children, function (row) {
        if (row.classList.contains("family-detail-row") && groups.length) groups[groups.length - 1].push(row);
        else groups.push([row]);
      });
      if (groups.length < 2) return;
      groups.sort(function (a, b) {
        var cellA = a[0].children[state.index];
        var cellB = b[0].children[state.index];
        if (!cellA || !cellB) return 0;
        var va = sortCellValue(cellA);
        var vb = sortCellValue(cellB);
        // Blanks sit at the bottom whichever way the column is sorted.
        if (va.type === "empty" && vb.type === "empty") return 0;
        if (va.type === "empty") return 1;
        if (vb.type === "empty") return -1;
        var result = va.value < vb.value ? -1 : va.value > vb.value ? 1 : 0;
        return state.dir === "asc" ? result : -result;
      });
      var fragment = document.createDocumentFragment();
      groups.forEach(function (group) { group.forEach(function (row) { fragment.appendChild(row); }); });
      body.appendChild(fragment);
    }

    function markSortedHeader(bodyId) {
      var body = document.getElementById(bodyId);
      var table = body && body.closest ? body.closest("table") : null;
      if (!table) return;
      var state = tableSortState[bodyId];
      Array.prototype.forEach.call(table.querySelectorAll("thead th"), function (th, index) {
        th.classList.remove("sorted-asc", "sorted-desc");
        if (state && index === state.index) th.classList.add(state.dir === "asc" ? "sorted-asc" : "sorted-desc");
      });
    }

    function renderRows(id, rows) {
      var body = document.getElementById(id);
      if (!body) return;
      body.innerHTML = rows.join("");
      applyTableSort(id);
      markSortedHeader(id);
    }

    function writeDevOutput(title, payload) {
      if (!devOutput) return;
      devOutput.textContent = title + "\n" + JSON.stringify(payload, null, 2);
      var liveStatus = document.getElementById("admin-live-status");
      if (liveStatus) {
        liveStatus.textContent = title;
        liveStatus.classList.add("is-active");
      }
    }

    function exceptionNextStep(action, payload) {
      var email = payload && payload.email ? payload.email : "the parent";
      if (action === "partial_refund") return "Next step: send the refund note and watch for a follow-up reply from " + email + ".";
      if (action === "credit_next_invoice") return "Next step: tell the parent the credit will appear on the next invoice.";
      if (action === "add_free_months") return "Next step: send a make-good email and confirm the new access date.";
      if (action === "apply_discount") return "Next step: confirm the next invoice discount and monitor renewal.";
      if (action === "extend_access") return "Next step: ask the parent to retry the product before the grace access expires.";
      if (action === "pause_billing") return "Next step: set a restart reminder before the pause becomes forgotten churn.";
      if (action === "cancel_period_end") return "Next step: send a brief cancellation confirmation and winback note.";
      if (action === "send_save_email") return "Next step: wait for parent response, then decide whether to add credit or free time.";
      return "Next step: review the family account and close the loop with the parent.";
    }

    function writeExceptionOutput(title, payload, state) {
      if (!exceptionOutput) return;
      var action = payload && payload.action ? payload.action : "";
      var message = payload && payload.message ? payload.message : payload && payload.error ? payload.error : "Action recorded.";
      var meta = [];
      if (payload && payload.mode) meta.push(payload.mode);
      if (payload && payload.email) meta.push(payload.email);
      if (payload && payload.reason) meta.push(payload.reason);
      exceptionOutput.innerHTML =
        "<div>" +
          "<strong>" + escapeHtml(title) + "</strong>" +
          "<small>" + escapeHtml(message) + "</small>" +
          "<p>" + escapeHtml(exceptionNextStep(action, payload || {})) + "</p>" +
          (meta.length ? "<b>" + escapeHtml(meta.join(" · ")) + "</b>" : "") +
        "</div>";
      if (exceptionResultState) {
        exceptionResultState.textContent = state || "Done";
        exceptionResultState.className = "state-chip " + (state === "Error" ? "error" : state === "Working" ? "warning" : "active");
      }
      var liveStatus = document.getElementById("admin-live-status");
      if (liveStatus) {
        liveStatus.textContent = title;
        liveStatus.classList.add("is-active");
      }
    }

    async function fetchJson(url, options) {
      var response = await apiFetch(url, options || {});
      var payload = await response.json();
      if (!response.ok) {
        throw payload;
      }
      return payload;
    }

    // ---- Autopilot: exceptions queue + rules + manual sweep -----------------
    function actionQueueMarkup(item) {
      var pri = item.priority <= 1 ? "High" : item.priority === 2 ? "Medium" : "Low";
      var icons = { deletion: "shield-alert", payment_suspended: "lock", dunning: "credit-card", refund: "receipt", cancel_scheduled: "calendar-x" };
      return "<div class='action-item'>" +
        "<span class='action-icon'><i data-lucide='" + (icons[item.category] || "circle-alert") + "'></i></span>" +
        "<div><strong>" + text(item.title) + "</strong><small>" + text(item.detail) + (item.email ? " — " + text(item.email) : "") + "</small></div>" +
        "<span class='priority-pill " + pri.toLowerCase() + "'>" + pri + "</span>" +
      "</div>";
    }

    async function refreshActionQueue() {
      try {
        var data = await fetchJson("/api/admin/action-queue");
        setMetric("action-count", data.count);
        renderMarkup("daily-action-list", data.items.length
          ? data.items.slice(0, 8).map(actionQueueMarkup).join("")
          : "<div class='empty-state'>All clear — nothing needs you right now.</div>");
        renderIcons();
      } catch (error) { /* keep client-side fallback */ }
    }

    function applyAutopilotRules(rules) {
      rules = rules || {};
      var s = document.getElementById("rule-suspend-days"); if (s) s.value = rules.dunningSuspendDays || 10;
      var w = document.getElementById("rule-winback-days"); if (w) w.value = rules.winbackAfterDays || 14;
      var n = document.getElementById("rule-nudge-days"); if (n) n.value = (rules.convertNudgeDays || [1, 3, 7]).join(",");
      var k = document.getElementById("rule-weekly-summary"); if (k) k.checked = rules.weeklySummaryEnabled !== false;
    }

    async function loadAutopilotRules() {
      try {
        var data = await fetchJson("/api/admin/autopilot-rules");
        applyAutopilotRules(data.rules);
      } catch (error) { /* ignore */ }
    }

    function setAutopilotStatus(label, state) {
      var el = document.getElementById("autopilot-status");
      if (!el) return;
      el.textContent = label;
      el.className = "state-chip " + (state || "");
    }

    async function saveAutopilotRules() {
      setAutopilotStatus("Saving…", "");
      try {
        var nudge = String((document.getElementById("rule-nudge-days") || {}).value || "")
          .split(",").map(function (x) { return Number(x.trim()); }).filter(function (x) { return !isNaN(x); });
        var data = await fetchJson("/api/admin/autopilot-rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dunningSuspendDays: Number(document.getElementById("rule-suspend-days").value) || 10,
            winbackAfterDays: Number(document.getElementById("rule-winback-days").value) || 14,
            convertNudgeDays: nudge.length ? nudge : [1, 3, 7],
            weeklySummaryEnabled: document.getElementById("rule-weekly-summary").checked
          })
        });
        applyAutopilotRules(data.rules);
        setAutopilotStatus("Saved", "active");
      } catch (error) {
        setAutopilotStatus("Error", "warning");
      }
    }

    async function runSweepNow() {
      setAutopilotStatus("Running…", "");
      try {
        var r = await fetchJson("/api/admin/run-sweep", { method: "POST" });
        var emails = (r.nudged || 0) + (r.winbacks || 0) + (r.summaries || 0) + (r.remindersSent || 0) + (r.suspended || 0);
        setAutopilotStatus("Done — " + (r.suspended || 0) + " suspended, " + (r.reconciled || 0) + " reconciled, " + emails + " emails", "active");
        await refreshActionQueue();
      } catch (error) {
        setAutopilotStatus("Error", "warning");
      }
    }

    async function refreshDevStatus() {
      if (!document.getElementById("dev-stripe-status")) return;
      try {
        var status = await fetchJson("/api/dev/status");
        document.getElementById("dev-stripe-status").textContent = status.stripe.mode;
        document.getElementById("dev-email-status").textContent = status.email.mode;
        document.getElementById("dev-login-status").textContent = status.login.adminConfigured ? "configured" : "demo";
        document.getElementById("dev-webhook-status").textContent = status.stripe.webhookConfigured ? "configured" : "mock";
        setMetric("payment-stripe-mode", status.stripe.mode);
      } catch (error) {
        document.getElementById("dev-stripe-status").textContent = "error";
        writeDevOutput("Status check failed", error);
      }
    }

    var SUPPORTED_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
    var VOICE_LABELS = { marin: "Marin — calm tutor", cedar: "Cedar — steady tutor", sage: "Sage — gentle guide" };
    function voiceLabel(v) { return VOICE_LABELS[v] || (String(v).charAt(0).toUpperCase() + String(v).slice(1)); }

    function defaultAiSettings() {
      return {
        hasOpenAIKey: false,
        maskedOpenAIKey: "",
        mathProblemsPerUserDaily: 20,
        tutorVoiceMinutesPerUserDaily: 10,
        tokensPerFamilyDaily: 60000,
        tutorVoiceEnabled: true,
        ttsModel: "gpt-4o-mini-tts",
        supportedTtsModels: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
        ttsDefaultVoice: "marin",
        ttsAllowedVoices: ["marin", "cedar", "sage"],
        supportedTtsVoices: SUPPORTED_TTS_VOICES,
        tutorExplainMaxWords: { "K-2": 160, "3-5": 400, "6-8": 700, "9-12": 1000 },
        tutorStandardFraction: 0.5,
        deepDiveBands: ["3-5", "6-8", "9-12"],
        wordsPerMinute: 150,
        updatedAt: "",
        updatedBy: ""
      };
    }

    var GRADE_BANDS = ["K-2", "3-5", "6-8", "9-12"];

    function renderTtsModelOptions(settings) {
      var sel = document.getElementById("tts-model");
      if (!sel) return;
      var models = (settings.supportedTtsModels && settings.supportedTtsModels.length) ? settings.supportedTtsModels.slice() : ["gpt-4o-mini-tts"];
      var current = settings.ttsModel || models[0];
      if (models.indexOf(current) < 0) models = [current].concat(models);
      sel.innerHTML = models.map(function (m) {
        return '<option value="' + text(m) + '"' + (m === current ? " selected" : "") + ">" + text(m) + "</option>";
      }).join("");
    }

    function renderWordTargets(settings) {
      var el = document.getElementById("tutor-word-targets");
      if (!el) return;
      var maxWords = settings.tutorExplainMaxWords || {};
      var fraction = Number(settings.tutorStandardFraction) || 0.5;
      var wpm = Number(settings.wordsPerMinute) || 150;
      var deepBands = settings.deepDiveBands || ["3-5", "6-8", "9-12"];
      el.innerHTML = GRADE_BANDS.map(function (b) {
        var mx = Number(maxWords[b] || 0);
        var std = Math.round(mx * fraction);
        var deepOk = deepBands.indexOf(b) >= 0;
        var mins = (mx / wpm).toFixed(1);
        var note = deepOk
          ? ("Standard " + std + " · Deep " + mx + " words · up to ~" + mins + " min")
          : ("Standard only · plays " + std + " words");
        return '<div class="word-target-row" style="display:flex;gap:8px;align-items:center;margin:4px 0">' +
          '<span style="width:44px;font-weight:600">' + text(b) + '</span>' +
          '<input type="number" min="40" max="4000" step="10" data-band="' + text(b) + '" value="' + mx + '" style="width:90px">' +
          '<span style="font-size:12px;opacity:.8">' + text(note) + '</span></div>';
      }).join("");
    }

    function collectMaxWords() {
      var out = {};
      Array.prototype.forEach.call(document.querySelectorAll('#tutor-word-targets input[data-band]'), function (input) {
        out[input.getAttribute("data-band")] = Number(input.value || 0);
      });
      return out;
    }

    function checkedShortlistVoices() {
      return Array.from(document.querySelectorAll('#tts-voice-list input[data-tts-voice]:checked')).map(function (i) { return i.value; });
    }

    // Rebuild the default-voice dropdown from the currently-checked shortlist,
    // keeping `preferred` selected if it's still allowed (else marin/cedar/sage).
    function rebuildDefaultVoiceOptions(preferred) {
      var defaultEl = document.getElementById("tts-default-voice");
      if (!defaultEl) return;
      var allowed = checkedShortlistVoices();
      if (!allowed.length) allowed = ["marin", "cedar", "sage"];
      var current = preferred && allowed.indexOf(preferred) >= 0
        ? preferred
        : (["marin", "cedar", "sage"].filter(function (v) { return allowed.indexOf(v) >= 0; })[0] || allowed[0]);
      defaultEl.innerHTML = allowed.map(function (v) {
        return '<option value="' + v + '"' + (v === current ? " selected" : "") + ">" + text(voiceLabel(v)) + "</option>";
      }).join("");
    }

    function renderVoiceShortlist(settings) {
      var listEl = document.getElementById("tts-voice-list");
      if (!listEl) return;
      var supported = (settings.supportedTtsVoices && settings.supportedTtsVoices.length) ? settings.supportedTtsVoices : SUPPORTED_TTS_VOICES;
      var allowed = (settings.ttsAllowedVoices && settings.ttsAllowedVoices.length) ? settings.ttsAllowedVoices : ["marin", "cedar", "sage"];
      listEl.innerHTML = supported.map(function (v) {
        var checked = allowed.indexOf(v) >= 0;
        return '<label class="' + (checked ? "is-checked" : "") + '"><input type="checkbox" value="' + v + '" data-tts-voice' + (checked ? " checked" : "") + "><span>" + text(voiceLabel(v)) + "</span></label>";
      }).join("");
      rebuildDefaultVoiceOptions(settings.ttsDefaultVoice || allowed[0]);
    }

    function setAiSettingsState(label, state) {
      if (!aiSettingsState) return;
      aiSettingsState.textContent = label || "Ready";
      aiSettingsState.className = "state-chip " + (state || "ready");
    }

    function renderAiSettings() {
      var settings = Object.assign(defaultAiSettings(), aiSettingsCache || {});
      if (aiSettingsForm) {
        aiSettingsForm.elements.openaiApiKey.value = "";
        // Show the stored (masked) key as the placeholder so it's obvious a key
        // is saved even though the field is intentionally blanked.
        aiSettingsForm.elements.openaiApiKey.placeholder = settings.hasOpenAIKey
          ? "Stored: " + settings.maskedOpenAIKey + " — leave blank to keep"
          : "sk-...";
        if (aiSettingsForm.elements.openaiModel) aiSettingsForm.elements.openaiModel.value = settings.openaiModel || "gpt-5.6-luna";
        aiSettingsForm.elements.mathProblemsPerUserDaily.value = Number(settings.mathProblemsPerUserDaily || 0);
        aiSettingsForm.elements.tutorVoiceMinutesPerUserDaily.value = Number(settings.tutorVoiceMinutesPerUserDaily || 0);
        if (aiSettingsForm.elements.tokensPerFamilyDaily) aiSettingsForm.elements.tokensPerFamilyDaily.value = Number(settings.tokensPerFamilyDaily || 0);
        aiSettingsForm.elements.tutorVoiceEnabled.checked = settings.tutorVoiceEnabled !== false;
        if (aiSettingsForm.elements.tutorStandardPercent) aiSettingsForm.elements.tutorStandardPercent.value = Math.round((Number(settings.tutorStandardFraction) || 0.5) * 100);
        renderTtsModelOptions(settings);
        renderVoiceShortlist(settings);
        renderWordTargets(settings);
      }
      renderMarkup("ai-runtime-rules", [
        ruleMarkup("Math Step Tutor problem cap", "Extension should call the usage limits endpoint before solving another screenshot or typed math problem.", "active", "calculator"),
        ruleMarkup("Tutor voice daily minutes", "Voice explanations stop when the per-student daily minute cap is reached.", settings.tutorVoiceEnabled ? "active" : "paused", "mic"),
        ruleMarkup("Server-side OpenAI key", "Keep model calls on the backend so the extension never ships the secret key.", settings.hasOpenAIKey ? "active" : "pending", "key-round"),
        ruleMarkup("Graceful fallback", "If the key is missing, tools should show text-only guided steps instead of crashing.", "ready", "shield-check")
      ].join(""));
    }

    async function loadAiSettings() {
      try {
        aiSettingsCache = await fetchJson("/api/admin/ai-settings");
      } catch (error) {
        aiSettingsCache = defaultAiSettings();
        setAiSettingsState("Unavailable", "warning");
      }
      renderAiSettings();
      return aiSettingsCache;
    }

    async function saveAiSettings(clearKey) {
      if (!aiSettingsForm) return;
      setAiSettingsState("Saving", "warning");
      try {
        aiSettingsCache = await fetchJson("/api/admin/ai-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            openaiApiKey: clearKey ? "" : aiSettingsForm.elements.openaiApiKey.value.trim(),
            clearOpenAIKey: Boolean(clearKey),
            openaiModel: aiSettingsForm.elements.openaiModel ? aiSettingsForm.elements.openaiModel.value.trim() : undefined,
            mathProblemsPerUserDaily: Number(aiSettingsForm.elements.mathProblemsPerUserDaily.value || 0),
            tutorVoiceMinutesPerUserDaily: Number(aiSettingsForm.elements.tutorVoiceMinutesPerUserDaily.value || 0),
            tokensPerFamilyDaily: aiSettingsForm.elements.tokensPerFamilyDaily ? Number(aiSettingsForm.elements.tokensPerFamilyDaily.value || 0) : undefined,
            tutorVoiceEnabled: aiSettingsForm.elements.tutorVoiceEnabled.checked,
            ttsModel: (document.getElementById("tts-model") || {}).value || undefined,
            ttsAllowedVoices: checkedShortlistVoices(),
            ttsDefaultVoice: (document.getElementById("tts-default-voice") || {}).value || undefined,
            tutorStandardFraction: (Number((aiSettingsForm.elements.tutorStandardPercent || {}).value || 0) / 100) || undefined,
            tutorExplainMaxWords: collectMaxWords()
          })
        });
        setAiSettingsState(clearKey ? "Key cleared" : "Saved", "active");
        renderAiSettings();
        writeDevOutput(clearKey ? "OpenAI key cleared" : "AI controls saved", aiSettingsCache);
      } catch (error) {
        setAiSettingsState("Error", "error");
        writeDevOutput("AI controls save failed", error);
      }
    }

    function syncPricingForm() {
      var pricing = readPricing();
      pricingFormSynced = true;
      syncPlanSetupFields();
      if (pricingForm.elements.promotionEnabled) pricingForm.elements.promotionEnabled.checked = pricing.promotion.enabled !== false;
      if (pricingForm.elements.promoMonthlyCode) pricingForm.elements.promoMonthlyCode.value = pricing.promotion.monthlyCode || pricing.promotion.code || "";
      if (pricingForm.elements.promoYearlyCode) pricingForm.elements.promoYearlyCode.value = pricing.promotion.yearlyCode || pricing.promotion.code || "";
      // Blank means "no discount on this plan". Writing 0 here made a disabled
      // plan look like a $0 price, which is why a monthly override appeared set
      // but never reached the portal.
      var promoMonthlyValue = promotionAmountForPlan(pricing.promotion, "monthly");
      var promoYearlyValue = promotionAmountForPlan(pricing.promotion, "yearly");
      if (pricingForm.elements.promoMonthlyPrice) pricingForm.elements.promoMonthlyPrice.value = promoMonthlyValue ? Number(promoMonthlyValue) : "";
      if (pricingForm.elements.promoYearlyPrice) pricingForm.elements.promoYearlyPrice.value = promoYearlyValue ? Number(promoYearlyValue) : "";
      if (pricingForm.elements.promoDescription) pricingForm.elements.promoDescription.value = pricing.promotion.description || "";
      var upgrade = pricing.yearlyUpgrade || {};
      if (pricingForm.elements.upgradeBonusMonths) pricingForm.elements.upgradeBonusMonths.value = Number(upgrade.bonusMonths != null ? upgrade.bonusMonths : 3);
      if (pricingForm.elements.upgradeDiscountAmount) pricingForm.elements.upgradeDiscountAmount.value = Number(upgrade.discountAmount || 0);
      if (pricingForm.elements.upgradeNote) pricingForm.elements.upgradeNote.value = upgrade.note || "";
      var cancellationPromo = pricing.cancellationPromo || {};
      if (pricingForm.elements.cancellationPromoEnabled) pricingForm.elements.cancellationPromoEnabled.checked = cancellationPromo.enabled !== false;
      if (pricingForm.elements.cancellationPromoAmountOff) pricingForm.elements.cancellationPromoAmountOff.value = Number(cancellationPromo.amountOff || 0);
      if (pricingForm.elements.cancellationPromoDuration) pricingForm.elements.cancellationPromoDuration.value = cancellationPromo.duration === "repeating" ? "repeating" : "once";
      if (pricingForm.elements.cancellationPromoDescription) pricingForm.elements.cancellationPromoDescription.value = cancellationPromo.description || "";
      if (stripeTestForm && stripeTestForm.elements.priceId) {
        stripeTestForm.elements.priceId.value = pricing.monthly.stripePriceId || "price_demo_monthly";
      }
    }

    // Without this the form saved silently: no chip, no button state, so a click
    // read as "nothing happened" even though the write succeeded.
    function setPricingSaveState(label, state) {
      var chip = document.getElementById("pricing-save-state");
      if (!chip) return;
      chip.hidden = !label;
      chip.textContent = label;
      chip.className = "state-chip " + (state || "ready");
    }

    function planSetupKey() {
      return pricingForm.elements.planSetupKey ? pricingForm.elements.planSetupKey.value : "monthly";
    }

    function syncPlanSetupFields() {
      var pricing = readPricing();
      var key = planSetupKey();
      var plan = pricing[key] || pricing.monthly;
      if (pricingForm.elements.planAmount) pricingForm.elements.planAmount.value = Number(plan.amount || 0);
      if (pricingForm.elements.planStripePriceId) pricingForm.elements.planStripePriceId.value = plan.stripePriceId || "";
      if (pricingForm.elements.planFamilyMemberCount) pricingForm.elements.planFamilyMemberCount.value = Number(plan.familyMemberCount || 3);
      // The toggle drives both halves of the card. Both promo inputs stay in the
      // DOM — only one is shown — so each plan keeps its own price and the save
      // handler can still read both.
      var planTitle = document.getElementById("plan-details-title");
      if (planTitle) planTitle.textContent = (key === "yearly" ? "Yearly" : "Monthly") + " plan details";
      Array.prototype.forEach.call(document.querySelectorAll("[data-promo-plan]"), function (field) {
        field.hidden = field.dataset.promoPlan !== key;
      });
    }

    function labelForException(action) {
      var map = {
        discount_next_renewal: "Next-renewal discount",
        apply_discount: "% discount",
        partial_refund: "Partial refund",
        credit_next_invoice: "Invoice credit",
        add_free_months: "Free months",
        extend_access: "Access extended",
        pause_billing: "Billing paused",
        cancel_period_end: "Cancel scheduled",
        send_save_email: "Save email"
      };
      return map[action] || action;
    }

    function populateExceptionFamilies() {
      var select = document.getElementById("exception-family-select");
      if (!select) return;
      var query = exceptionParentSearch ? exceptionParentSearch.value.trim().toLowerCase() : "";
      var families = readFamilies().filter(function (f) {
        if (familyDeleted(f)) return false;
        var haystack = [f.parentName, f.email, f.studentName, f.plan].join(" ").toLowerCase();
        return !query || haystack.indexOf(query) >= 0;
      }).slice(0, 60);
      var prev = select.value || selectedExceptionFamilyId;
      select.innerHTML = families.map(function (f) {
        return "<option value='" + familyRowId(f) + "'>" + escapeHtml((f.parentName || "Parent") + " (" + f.email + ")") + "</option>";
      }).join("");
      if (prev) select.value = prev;
      selectedExceptionFamilyId = select.value || "";
    }

    function renderExceptionLog() {
      var rows = [];
      readFamilies().forEach(function (f) {
        (f.billingExceptions || []).forEach(function (ex) {
          rows.push({ name: f.parentName, email: f.email, familyId: familyRowId(f), ex: ex });
        });
      });
      rows.sort(function (a, b) { return new Date(b.ex.createdAt || 0) - new Date(a.ex.createdAt || 0); });
      renderMarkup("exception-log", rows.length ? rows.slice(0, 20).map(function (r) {
        var ex = r.ex;
        var amt = ex.amountCents ? "$" + (ex.amountCents / 100).toFixed(2)
          : ex.percentOff ? ex.percentOff + "%"
          : ex.creditCents ? "$" + (ex.creditCents / 100).toFixed(2) + " credit" : "—";
        return "<tr><td>" + text(r.name || "Parent") + "<small>" + text(r.email) + "</small></td><td>" + text(labelForException(ex.action)) + "</td><td>" + amt + "</td><td>" + text(ex.reason || "") + "</td><td>" + rowDateTime(ex.createdAt) + "</td><td><button type='button' class='table-action' data-customer-open data-family-id='" + escapeHtml(r.familyId) + "'>View</button></td></tr>";
      }).join("") : "<tr><td colspan='6' class='empty-state'>No exceptions applied yet.</td></tr>");
    }

    async function applyException() {
      var select = document.getElementById("exception-family");
      var amountEl = document.getElementById("exception-amount");
      var reasonEl = document.getElementById("exception-reason");
      var status = document.getElementById("exception-status");
      function setStatus(label, cls) { if (status) { status.textContent = label; status.className = "state-chip " + (cls || ""); } }
      if (!select || !select.value) return setStatus("Pick a family", "warning");
      var amountCents = Math.round((Number(amountEl && amountEl.value) || 0) * 100);
      if (amountCents < 50) return setStatus("Enter an amount", "warning");
      setStatus("Applying…", "");
      try {
        var result = await fetchJson("/api/admin/billing-exception", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "discount_next_renewal",
            familyId: select.value,
            amountCents: amountCents,
            reason: ((reasonEl && reasonEl.value) || "Complaint make-good").trim()
          })
        });
        setStatus("Applied", "active");
        writeDevOutput("Next-renewal discount applied", result);
        await loadBackendState();
        renderAdmin();
      } catch (error) {
        setStatus("Error", "warning");
        writeDevOutput("Exception failed", error);
      }
    }

    var issuesCache = [];
    async function loadIssues() {
      try {
        var data = await fetchJson("/api/admin/issues");
        issuesCache = data.issues || [];
        renderIssues();
      } catch (error) { /* ignore */ }
    }
    function renderIssues() {
      var filterEl = document.getElementById("issue-type-filter");
      var filter = filterEl ? filterEl.value : "all";
      var open = issuesCache.filter(function (i) { return i.status !== "resolved"; }).length;
      setMetric("issue-open-count", open + " open");
      var items = issuesCache.filter(function (i) { return filter === "all" || i.type === filter; });
      renderMarkup("issues-table", items.length ? items.slice(0, 100).map(function (i) {
        var status = i.status === "resolved"
          ? "<span class='state-chip active'>Resolved</span>"
          : "<span class='state-chip warning'>Open</span>";
        return "<tr><td>" + rowDateTime(i.createdAt) + "</td><td>" + text(i.label || i.type) + "</td><td>" + text(i.email || "—") + "</td><td>" + text(i.detail || "—") + "</td><td>" + status + "</td>" +
          "<td><button type='button' class='table-action' data-issue-resolve='" + i.id + "'>" + (i.status === "resolved" ? "Reopen" : "Resolve") + "</button></td></tr>";
      }).join("") : "<tr><td colspan='6' class='empty-state'>No issues reported.</td></tr>");
    }
    async function resolveIssue(id) {
      try {
        await fetchJson("/api/admin/issues/" + encodeURIComponent(id) + "/resolve", { method: "POST" });
        await loadIssues();
      } catch (error) { /* ignore */ }
    }

    // ---- Weekly log digest (issues grouped by type; extension-first) --------
    async function loadLogDigest() {
      var rangeEl = document.getElementById("digest-range");
      var statusEl = document.getElementById("digest-status");
      var days = rangeEl ? rangeEl.value : "7";
      if (statusEl) { statusEl.textContent = "Reading…"; statusEl.className = "state-chip warning"; }
      try {
        var data = await fetchJson("/api/admin/logs/digest?days=" + encodeURIComponent(days));
        renderLogDigest(data);
        if (statusEl) {
          statusEl.textContent = data.totals.errors > 0 ? data.totals.errors + " errors" : data.totals.signals > 0 ? "Review" : "Healthy";
          statusEl.className = "state-chip " + (data.totals.errors > 0 ? "error" : data.totals.signals > 0 ? "warning" : "ok");
        }
      } catch (error) {
        if (statusEl) { statusEl.textContent = "Failed"; statusEl.className = "state-chip error"; }
        var groupsEl = document.getElementById("digest-groups");
        if (groupsEl) groupsEl.innerHTML = "<div class='digest-empty'>Could not load the digest. Try Refresh.</div>";
      }
    }

    function digestSevClass(sev) { return sev === "error" ? "sev-error" : sev === "warning" ? "sev-warning" : "sev-none"; }

    function renderLogDigest(data) {
      var t = data.totals || {};
      var statsEl = document.getElementById("digest-stats");
      if (statsEl) {
        statsEl.innerHTML =
          "<div class='digest-stat extension'><b>" + (t.extensionSignals || 0) + "</b><span>Extension signals</span></div>" +
          "<div class='digest-stat'><b>" + (t.errors || 0) + "</b><span>Errors</span></div>" +
          "<div class='digest-stat'><b>" + (t.signals || 0) + "</b><span>Total signals</span></div>" +
          "<div class='digest-stat'><b>" + (t.affectedUsers || 0) + "</b><span>Affected users</span></div>";
      }
      var aiEl = document.getElementById("digest-ai");
      if (aiEl) {
        if (data.aiSummary) { aiEl.hidden = false; aiEl.className = "digest-ai"; aiEl.innerHTML = "<i data-lucide='sparkles'></i><p>" + text(data.aiSummary) + "</p>"; }
        else if (!data.aiConfigured) { aiEl.hidden = false; aiEl.className = "digest-ai muted"; aiEl.innerHTML = "<i data-lucide='info'></i><p>Add an OpenAI key in AI &amp; Usage to get a written brief. The grouped list below works without it.</p>"; }
        else { aiEl.hidden = true; aiEl.innerHTML = ""; }
      }
      var groupsEl = document.getElementById("digest-groups");
      if (!groupsEl) return;
      var groups = data.groups || [];
      if (!groups.length) { groupsEl.innerHTML = "<div class='digest-empty'>No issues in the last " + (data.windowDays || 7) + " days. All clear.</div>"; renderIcons(); return; }
      groupsEl.innerHTML = groups.map(function (g) {
        var samples = (g.samples || []).slice(0, 2).map(function (s) {
          return "<li>" + text(s.detail) + (s.email ? " <em>· " + text(s.email) + "</em>" : "") + "</li>";
        }).join("");
        return "<article class='digest-group " + digestSevClass(g.severity) + "'>" +
          "<div class='digest-group-head'>" +
            "<span class='digest-dot'></span>" +
            "<div class='digest-group-title'><strong>" + text(g.title) + "</strong><small>" + text(g.hint) + "</small></div>" +
            "<div class='digest-group-metrics'>" +
              "<span class='digest-count'>" + g.count + "</span>" +
              (g.errors ? "<span class='digest-badge err'>" + g.errors + " err</span>" : "") +
              (g.userCount ? "<span class='digest-badge'>" + g.userCount + " user" + (g.userCount === 1 ? "" : "s") + "</span>" : "") +
            "</div>" +
          "</div>" +
          (samples ? "<ul class='digest-samples'>" + samples + "</ul>" : "") +
          "<div class='digest-group-foot'>Last seen " + rowDateTime(g.lastAt) + "</div>" +
        "</article>";
      }).join("");
      renderIcons();
    }

    // ---- Support helpdesk (email tickets grouped by parent) -------------
    var supportConvos = [];
    var selectedSupportEmail = "";
    var supportFilter = "unread";
    var supportSearch = "";
    var supportTopic = "all";
    var supportFrom = "";
    var supportTo = "";
    var supportMockMode = false;

    function demoSupportConversations() {
      var now = Date.now();
      return [
        {
          ticketId: "KG-1042", email: "maya.patel@gmail.com", name: "Maya Patel", familyId: "fam_demo_parent",
          subject: "I was charged after changing my plan", categories: ["Billing"], priority: "High", open: true, lastFrom: "parent",
          mock: true,
          lastAt: new Date(now - 2 * 3600000).toISOString(), lastMessage: "Can you confirm which plan is active now?",
          turns: [
            { from: "parent", message: "Hi, I upgraded to yearly but I am not sure which plan is active now. Can you check?", at: new Date(now - 3 * 3600000).toISOString(), category: "Billing" },
            { from: "admin", message: "Hi Maya, I’m checking the subscription record and will confirm the active plan for you.", at: new Date(now - 2.5 * 3600000).toISOString() },
            { from: "parent", message: "Thanks. Can you also confirm whether my unused monthly days were carried over?", at: new Date(now - 2 * 3600000).toISOString(), category: "Billing" }
          ]
        },
        {
          ticketId: "KG-1041", email: "jordan.lee@yahoo.com", name: "Jordan Lee", familyId: "fam_demo_jordan",
          subject: "Extension is ready to install", categories: ["Extension"], priority: "Normal", open: true, lastFrom: "admin",
          mock: true,
          lastAt: new Date(now - 20 * 3600000).toISOString(), lastMessage: "You can install it from the Chrome Web Store here.",
          turns: [
            { from: "parent", message: "We paid for the Family plan. Where do we install the extension?", at: new Date(now - 25 * 3600000).toISOString(), category: "Extension" },
            { from: "admin", message: "You can install it from the Chrome Web Store here. Once installed, sign in with this parent email.", at: new Date(now - 20 * 3600000).toISOString() }
          ]
        },
        {
          ticketId: "KG-1038", email: "priya.shah@outlook.com", name: "Priya Shah", familyId: "fam_demo_priya",
          subject: "Password reset completed", categories: ["Login"], priority: "Normal", open: false, lastFrom: "admin",
          mock: true,
          lastAt: new Date(now - 3 * 86400000).toISOString(), lastMessage: "Glad you’re back in. Reply here if anything else comes up.",
          turns: [
            { from: "parent", message: "The password reset code never arrived.", at: new Date(now - 4 * 86400000).toISOString(), category: "Login" },
            { from: "admin", message: "I re-sent the verification email. Glad you’re back in. Reply here if anything else comes up.", at: new Date(now - 3 * 86400000).toISOString() }
          ]
        }
      ];
    }

    function normaliseSupportConversation(conversation, index) {
      var c = Object.assign({}, conversation || {});
      c.ticketId = c.ticketId || "KG-" + String(1042 - index).padStart(4, "0");
      c.subject = c.subject || ((c.categories || ["Support"])[0] + " question");
      c.priority = c.priority || "Normal";
      c.turns = Array.isArray(c.turns) ? c.turns : [];
      c.lastFrom = c.lastFrom || ((c.turns[c.turns.length - 1] || {}).from || "parent");
      c.open = Boolean(c.open);
      c.mock = Boolean(c.mock);
      return c;
    }

    function selectedSupportConversation() {
      return supportConvos.find(function (c) { return c.email === selectedSupportEmail; }) || null;
    }

    function supportStatus(c) {
      if (!c.open) return "resolved";
      return c.lastFrom === "admin" ? "waiting" : "open";
    }

    function supportStatusLabel(c) {
      var status = supportStatus(c);
      return status === "resolved" ? "Resolved" : status === "waiting" ? "Waiting on parent" : "Needs reply";
    }

    function updateSupportSummary() {
      var needsReply = supportConvos.filter(function (c) { return supportStatus(c) === "open"; }).length;
      var waiting = supportConvos.filter(function (c) { return supportStatus(c) === "waiting"; }).length;
      ["support-open-count", "support-needs-reply-count"].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.textContent = needsReply;
      });
      ["support-waiting-count", "support-waiting-pill-count"].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.textContent = waiting;
      });
      updateSupportTopicCounts();
    }
    function updateSupportTopicCounts() {
      var topicIds = { all: "all", Billing: "billing", Login: "login", "Math tool": "math", Extension: "extension", Other: "other" };
      Object.keys(topicIds).forEach(function (topic) {
        var count = supportConvos.filter(function (c) {
          if (supportStatus(c) !== "open") return false;
          return topic === "all" || (c.categories || []).indexOf(topic) >= 0;
        }).length;
        var el = document.getElementById("support-topic-count-" + topicIds[topic]);
        if (el) el.textContent = count;
      });
    }
    function setSupportBadge(count) {
      var badge = document.getElementById("support-nav-badge");
      if (!badge) return;
      if (count > 0) { badge.textContent = count; badge.hidden = false; }
      else { badge.hidden = true; }
    }
    function filteredSupportConvos() {
      var q = supportSearch.trim().toLowerCase();
      var fromT = supportFrom ? new Date(supportFrom + "T00:00:00").getTime() : 0;
      var toT = supportTo ? new Date(supportTo + "T23:59:59").getTime() : 0;
      return supportConvos.filter(function (c) {
        if (supportFilter === "unread" && supportStatus(c) !== "open") return false;
        if (supportFilter === "waiting" && supportStatus(c) !== "waiting") return false;
        if (supportFilter === "resolved" && supportStatus(c) !== "resolved") return false;
        if (q && (c.name || "").toLowerCase().indexOf(q) < 0 && (c.email || "").toLowerCase().indexOf(q) < 0) return false;
        if (supportTopic !== "all" && (c.categories || []).indexOf(supportTopic) < 0) return false;
        var last = c.lastAt ? new Date(c.lastAt).getTime() : 0;
        if (fromT && last < fromT) return false;
        if (toT && last > toT) return false;
        return true;
      });
    }
    async function loadSupportConversations() {
      try {
        var data = await fetchJson("/api/admin/support/conversations");
        var conversations = Array.isArray(data.conversations) ? data.conversations : [];
        var shouldShowLocalPreview = window.location.hostname === "localhost" && !conversations.some(function (c) { return c.open; });
        supportMockMode = !conversations.length || shouldShowLocalPreview;
        supportConvos = (supportMockMode ? conversations.concat(demoSupportConversations()) : conversations).map(normaliseSupportConversation);
        updateSupportSummary();
        setSupportBadge(supportConvos.filter(function (c) { return supportStatus(c) === "open"; }).length);
        var visible = filteredSupportConvos();
        if (selectedSupportEmail && !visible.some(function (c) { return c.email === selectedSupportEmail; })) selectedSupportEmail = "";
        if (!selectedSupportEmail && visible.length) selectedSupportEmail = visible[0].email;
        renderSupportList();
        renderSupportConversation();
      } catch (error) {
        supportMockMode = true;
        supportConvos = demoSupportConversations().map(normaliseSupportConversation);
        updateSupportSummary();
        setSupportBadge(supportConvos.filter(function (c) { return supportStatus(c) === "open"; }).length);
        if (!selectedSupportEmail) selectedSupportEmail = supportConvos[0].email;
        renderSupportList();
        renderSupportConversation();
      }
    }
    function renderSupportList() {
      var list = document.getElementById("support-list");
      if (!list) return;
      var visible = filteredSupportConvos();
      list.innerHTML = visible.length ? visible.map(function (c) {
        var status = supportStatus(c);
        var preview = c.lastMessage || "No message preview";
        var initials = (c.name || c.email || "P").split(/\s+/).map(function (part) { return part.charAt(0); }).join("").slice(0, 2).toUpperCase();
        return "<button type='button' class='support-list-item" + (c.email === selectedSupportEmail ? " active" : "") + "' data-support-email='" + escapeHtml(c.email) + "'>" +
          "<span class='support-ticket-avatar " + (status === "open" ? "needs-reply" : "") + "'>" + escapeHtml(initials) + "</span>" +
          "<span class='support-ticket-copy'><span class='sli-top'><strong class='name'>" + escapeHtml(c.name || c.email) + "</strong><small class='ticket-time'>" + escapeHtml(relativeTicketTime(c.lastAt)) + "</small></span>" +
          "<span class='support-ticket-subject'>" + escapeHtml(c.subject) + "</span><span class='email'>" + escapeHtml(c.email) + "</span><span class='preview'>" + escapeHtml(preview) + "</span></span>" +
          "<span class='support-ticket-status " + status + "'>" + escapeHtml(status === "open" ? "Reply" : status === "waiting" ? "Waiting" : "Done") + "</span>" +
        "</button>";
      }).join("") : "<div class='support-list-empty'><i data-lucide='inbox'></i><span>" + (supportFilter === "unread" ? "No tickets need a reply." : "No tickets match these filters.") + "</span></div>";
      renderIcons();
    }

    function relativeTicketTime(iso) {
      var t = iso ? new Date(iso).getTime() : 0;
      if (!t) return "";
      var hours = Math.max(0, Math.floor((Date.now() - t) / 3600000));
      if (hours < 1) return "now";
      if (hours < 24) return hours + "h";
      var days = Math.floor(hours / 24);
      return days + "d";
    }
    function renderSupportConversation() {
      var pane = document.getElementById("support-conversation");
      if (!pane) return;
      var c = supportConvos.find(function (x) { return x.email === selectedSupportEmail; });
      if (!c) {
        pane.innerHTML = "<div class='support-empty-conv'><i data-lucide='messages-square'></i><p>Select a conversation to view and reply.</p></div>";
        renderIcons();
        return;
      }
      var status = supportStatus(c);
      var category = (c.categories || ["Other"])[0] || "Other";
      var family = (familiesCache || []).find(function (item) { return item.id === c.familyId || item.email === c.email; });
      var turns = c.turns.map(function (t) {
        var isAdmin = t.from === "admin";
        var sender = isAdmin ? "KiddieGPT Support" : (c.name || c.email);
        var recipient = isAdmin ? c.email : "support@kiddiegpt.com";
        return "<article class='support-email-message " + (isAdmin ? "admin" : "parent") + "'><div class='support-email-message-head'><span class='support-message-avatar " + (isAdmin ? "admin" : "parent") + "'>" + (isAdmin ? "K" : escapeHtml((c.name || "P").charAt(0).toUpperCase())) + "</span><span><strong>" + escapeHtml(sender) + "</strong><small>" + escapeHtml(recipient) + " · " + escapeHtml(rowDateTime(t.at)) + "</small></span><button class='support-message-more' type='button' aria-label='More email actions'><i data-lucide='more-horizontal'></i></button></div><p>" + escapeHtml(t.message) + "</p></article>";
      }).join("");
      var quickReply = category === "Billing" ? "Thanks for reaching out. I’m reviewing your subscription and payment history now and will follow up with the exact next step." : category === "Extension" ? "Thanks for reaching out. I’ll help you get the KiddieGPT extension installed and signed in." : "Thanks for reaching out. I’m looking into this now and will follow up shortly.";
      pane.innerHTML =
        "<div class='support-conv-head'><div class='support-conv-title'><div class='support-ticket-id'>" + escapeHtml(c.ticketId) + " · " + escapeHtml(category) + "</div><h3>" + escapeHtml(c.subject) + "</h3><p>" + escapeHtml(c.name || c.email) + " <span>·</span> " + escapeHtml(c.email) + "</p></div><div class='support-conv-actions'><span class='support-detail-status " + status + "'><i data-lucide='" + (status === "resolved" ? "check-circle-2" : status === "waiting" ? "clock-3" : "circle-dot") + "'></i>" + escapeHtml(supportStatusLabel(c)) + "</span><button type='button' class='table-action' id='support-resolve-btn'>" + (c.open ? "Resolve ticket" : "Reopen ticket") + "</button></div></div>" +
        "<div class='support-ticket-body'><div class='support-email-column'><div class='support-email-thread' id='support-messages'>" + turns + "</div><div class='support-composer'><div class='support-quick-replies'><span>Saved replies</span><button type='button' data-support-quick-reply='" + escapeHtml(quickReply) + "'>" + escapeHtml(category === "Billing" ? "Billing check-in" : category === "Extension" ? "Install help" : "First reply") + "</button><button type='button' data-support-quick-reply='Could you reply with the parent email and a screenshot or exact error message? That will help me check this quickly.'>Need more details</button><button type='button' data-support-quick-reply='Please sign out of the extension and sign back in with the parent email used for your KiddieGPT account. Reply here if the issue continues.'>Sign-in steps</button><button type='button' data-support-quick-reply='I’ve completed the requested update. Please reply here if you need anything else.'>Resolution follow-up</button></div><textarea id='support-reply-text' placeholder='Write an email reply to " + escapeHtml(c.name || "the parent") + "…'></textarea><div class='support-composer-foot'><small><i data-lucide='mail'></i>Reply will be sent by email</small><button type='button' class='button primary' id='support-reply-btn'><i data-lucide='send'></i>Send reply</button></div></div></div>" +
        "<aside class='support-context'><div class='support-context-head'><p class='eyebrow'>Family context</p><button type='button' class='text-button'>Open family</button></div><div class='support-family-card'><span class='support-family-avatar'>" + escapeHtml((c.name || "P").split(/\s+/).map(function (part) { return part.charAt(0); }).join("").slice(0, 2).toUpperCase()) + "</span><strong>" + escapeHtml(c.name || "Parent") + "</strong><small>" + escapeHtml(c.email) + "</small></div><div class='support-context-facts'><div><span>Plan</span><strong>" + escapeHtml(family ? (family.plan || "Family Monthly") : "Family Monthly") + "</strong></div><div><span>Access</span><strong class='support-access-ok'>Unlocked</strong></div><div><span>Students</span><strong>" + (family && family.children ? family.children.length : "1") + " profile</strong></div></div><div class='support-context-section'><p class='eyebrow'>Ticket details</p><div class='support-context-line'><span>Category</span><strong>" + escapeHtml(category) + "</strong></div><div class='support-context-line'><span>Priority</span><strong class='support-priority " + (c.priority === "High" ? "high" : "") + "'>" + escapeHtml(c.priority) + "</strong></div><div class='support-context-line'><span>Channel</span><strong>Email</strong></div></div><div class='support-context-section'><p class='eyebrow'>Internal note</p><textarea class='support-internal-note' placeholder='Only visible to your team…'></textarea><button type='button' class='table-action support-note-button'>Save note</button></div></aside></div>";
      var msgs = document.getElementById("support-messages");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      var replyBtn = document.getElementById("support-reply-btn");
      if (replyBtn) replyBtn.addEventListener("click", function () { sendSupportReply(c.email); });
      var resolveBtn = document.getElementById("support-resolve-btn");
      if (resolveBtn) resolveBtn.addEventListener("click", function () { resolveSupportConversation(c.email); });
      Array.prototype.forEach.call(pane.querySelectorAll("[data-support-quick-reply]"), function (button) {
        button.addEventListener("click", function () {
          var reply = document.getElementById("support-reply-text");
          if (reply) { reply.value = button.dataset.supportQuickReply; reply.focus(); }
        });
      });
      renderIcons();
    }
    async function sendSupportReply(email) {
      var t = document.getElementById("support-reply-text");
      var msg = t ? t.value.trim() : "";
      if (!msg) return;
      var btn = document.getElementById("support-reply-btn");
      if (btn) btn.disabled = true;
      try {
        if (selectedSupportConversation() && selectedSupportConversation().mock) {
          var mockConversation = supportConvos.find(function (c) { return c.email === email; });
          if (mockConversation) {
            mockConversation.turns.push({ from: "admin", message: msg, at: new Date().toISOString() });
            mockConversation.lastFrom = "admin";
            mockConversation.lastAt = new Date().toISOString();
            mockConversation.lastMessage = msg;
          }
          if (t) t.value = "";
          updateSupportSummary();
          setSupportBadge(supportConvos.filter(function (c) { return supportStatus(c) === "open"; }).length);
          renderSupportList();
          renderSupportConversation();
          return;
        }
        var replyResult = await fetchJson("/api/admin/support/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, message: msg }) });
        if (t) t.value = "";
        await loadSupportConversations();
        // The parent only ever sees this reply by email, so a delivery failure
        // must interrupt the operator rather than sit in a log.
        if (replyResult && replyResult.delivered === false) {
          window.alert(replyResult.warning || "Reply saved, but the email was not delivered. The parent has not been notified.");
        }
      } catch (error) {
        if (btn) btn.disabled = false;
      }
    }
    async function resolveSupportConversation(email) {
      try {
        if (selectedSupportConversation() && selectedSupportConversation().mock) {
          var mockConversation = supportConvos.find(function (c) { return c.email === email; });
          if (mockConversation) {
            mockConversation.open = !mockConversation.open;
            mockConversation.lastFrom = mockConversation.open ? "parent" : "admin";
            mockConversation.lastAt = new Date().toISOString();
          }
          updateSupportSummary();
          setSupportBadge(supportConvos.filter(function (c) { return supportStatus(c) === "open"; }).length);
          renderSupportList();
          renderSupportConversation();
          return;
        }
        await fetchJson("/api/admin/support/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email }) });
        await loadSupportConversations();
      } catch (error) { /* ignore */ }
    }

    function renderAiUsageTable() {
      var FLAG_TOKENS_PER_DAY = 50000;
      var cutoff = Date.now() - 6 * 86400000;
      var rows = [];
      var flagged = 0;
      readFamilies().forEach(function (f) {
        if (familyDeleted(f)) return;
        childrenOf(f).forEach(function (kid) {
          var daily = (kid.usage && kid.usage.daily) || {};
          var tokens = 0;
          var used = false;
          Object.keys(daily).forEach(function (d) {
            if (new Date(d + "T00:00:00Z").getTime() < cutoff) return;
            tokens += Number(daily[d].tokens) || 0;
            used = true;
          });
          var avg = Math.round(tokens / 7);
          var flag = avg > FLAG_TOKENS_PER_DAY;
          if (flag) flagged += 1;
          rows.push({
            parent: f.parentName || "Parent",
            student: kid.studentName || "Student",
            last: (kid.usage && kid.usage.lastExtensionUseAt) || f.lastExtensionUseAt || "",
            avg: avg,
            used: used,
            flag: flag
          });
        });
      });
      rows.sort(function (a, b) { return b.avg - a.avg; });
      setMetric("ai-usage-flags", flagged + " flagged");
      renderMarkup("ai-usage-table", rows.length ? rows.map(function (r) {
        var flagCell = r.flag
          ? "<span class='priority-pill high'>Review</span>"
          : (r.used ? "<span class='priority-pill low'>OK</span>" : "<span class='priority-pill'>—</span>");
        return "<tr><td>" + text(r.parent) + "</td><td>" + text(r.student) + "</td><td>" + (r.last ? rowDateTime(r.last) : "—") + "</td><td>" + r.avg.toLocaleString() + "</td><td>" + flagCell + "</td></tr>";
      }).join("") : "<tr><td colspan='5' class='empty-state'>No AI usage recorded yet.</td></tr>");
    }

    function renderAdmin() {
      var families = readFamilies();
      if (!families.length) {
        seedFamilies();
        families = readFamilies();
      }
      families = normaliseFamilies(families);
      var visible = filteredFamilies();
      var active = families.filter(function (family) { return family.subscriptionStatus === "active"; });
      var paidActive = active.filter(function (family) { return family.paymentStatus !== "refunded"; });
      var studentTotal = families.reduce(function (total, family) {
        return total + childrenOf(family).length;
      }, 0);
      var monthlyRevenue = paidActive.reduce(function (total, family) {
        return total + planNumericAmount(family.plan || moneyPlan());
      }, 0);
      var failedPayments = families.filter(function (family) { return family.paymentStatus === "failed"; });
      var refunded = families.filter(function (family) { return family.paymentStatus === "refunded"; });
      var exceptionFamilies = families.filter(function (family) {
        return billingExceptions(family).length || family.billingCreditCents || family.entitlementOverrideUntil || family.retentionOffer || family.yearlyUpgrade || family.paymentStatus === "partial_refunded";
      });
      var accessOverrideCount = families.filter(function (family) {
        return family.entitlementOverrideUntil && new Date(family.entitlementOverrideUntil).getTime() > Date.now();
      }).length;
      var exceptionCreditTotal = families.reduce(function (total, family) {
        return total + Number(family.billingCreditCents || 0);
      }, 0);
      var riskFamilies = families.filter(function (family) {
        return familyHealth(family).score < 60;
      });
      var deleteQueue = deletionRequests(families);
      var pendingDeletes = deleteQueue.filter(function (family) { return deletionStatus(family) === "requested"; });
      var anonymizedDeletes = deleteQueue.filter(function (family) { return deletionStatus(family) === "anonymized"; });
      // Both kinds of trial live here: admin-granted no-card trials ("trial")
      // and self-serve card-upfront Stripe trials ("trialing"). Neither has been
      // charged, so neither appears in Accounts — without this a Stripe trial
      // would be invisible in the console entirely.
      // Free Trial tab lists ONLY admin-granted (no-card) trials — the comped
      // accounts an operator created. A Stripe trial has a card on file and is a
      // self-serve customer, so it stays on Accounts.
      var trialFamilies = families.filter(function (family) {
        return Boolean(family.trialStartedAt) && !family.trialUsedAt;
      });
      var actions = adminActions(families);
      var activationCount = families.filter(function (family) {
        return family.subscriptionStatus === "active" && childrenOf(family).length > 0;
      }).length;
      var engagedStudents = families.reduce(function (total, family) {
        return total + (daysSinceActivity(family) <= 7 ? childrenOf(family).length : 0);
      }, 0);

      setMetric("active-subs", active.length);
      setMetric("student-count", studentTotal);
      setMetric("monthly-revenue", money(monthlyRevenue));
      setMetric("action-count", actions.length);
      setMetric("activation-rate", percent(activationCount, families.length));
      setMetric("engagement-rate", percent(engagedStudents, studentTotal));
      setMetric("churn-risk", riskFamilies.length);
      renderAbuseTile(families);
      setMetric("failed-payment-count", failedPayments.length);
      setMetric("payment-collected", money(monthlyRevenue));
      setMetric("payment-failed", money(failedPayments.reduce(function (total, family) { return total + planNumericAmount(family.plan || moneyPlan()); }, 0)));
      setMetric("payment-refunded", money(refunded.reduce(function (total, family) { return total + planNumericAmount(family.plan || moneyPlan()); }, 0)));
      var collectedCents = paymentsCache.reduce(function (total, payment) {
        return total + (Number(payment.amountCents || 0) > 0 && payment.status !== "refunded" ? Number(payment.amountCents || 0) : 0);
      }, 0);
      var refundedCents = paymentsCache.reduce(function (total, payment) {
        return total + (payment.status === "refunded" ? Number(payment.amountCents || 0) : 0);
      }, 0);
      setMetric("net-collected", moneyFromCents(Math.max(0, collectedCents - refundedCents)));
      setMetric("billing-net-collected", moneyFromCents(Math.max(0, collectedCents - refundedCents)));
      setMetric("billing-follow-up", failedPayments.length);
      setMetric("billing-refunded-active", families.filter(function (family) { return (family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded") && familySubscriptionActive(family); }).length);
      setMetric("billing-reconciliation-alerts", reconciliationIssuesForFamilies(families));
      setMetric("billing-alert-count", failedPayments.length + reconciliationIssuesForFamilies(families));
      var allTrials = families.filter(function (family) { return family.subscriptionStatus === "trial" || family.subscriptionStatus === "trialing"; });
      var cardTrials = allTrials.filter(function (family) { return family.subscriptionStatus === "trialing" || Boolean(family.stripeSubscriptionId && family.trialEndsAt); });
      setMetric("trial-conversion-rate", percent(cardTrials.length, allTrials.length));
      setMetric("exception-save-count", exceptionFamilies.length);
      setMetric("payment-toggle-exceptions", exceptionFamilies.length);
      setMetric("exception-credit-total", "$" + Math.round(exceptionCreditTotal / 100));
      setMetric("exception-access-count", accessOverrideCount);
      setMetric("exception-refund-count", families.filter(function (family) {
        return family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded";
      }).length);
      setMetric("log-count", auditLogsCache.length);
      setMetric("log-billing-count", auditLogsCache.filter(function (log) { return logCategory(log) === "billing"; }).length);
      setMetric("log-email-count", emailLogsCache.length);
      setMetric("monitor-count", monitorEventsCache.length);
      setMetric("monitor-error-count", monitorEventsCache.filter(function (event) { return event.severity === "error"; }).length + " errors");
      familyTableButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.familyTable === activeFamilyTable);
      });
      familyTablePanels.forEach(function (panel) {
        panel.hidden = panel.dataset.familyTablePanel !== activeFamilyTable;
      });
      renderAiSettings();

      var healthChip = document.getElementById("business-health-chip");
      if (healthChip) {
        var healthStatus = actions.length > 4 ? "Needs focus" : actions.length ? "Stable" : "Healthy";
        healthChip.textContent = healthStatus;
        healthChip.className = "state-chip " + (actions.length > 4 ? "pending" : "active");
      }

      renderMarkup("daily-action-list", actions.length ? actions.slice(0, 5).map(actionItemMarkup).join("") : "<div class='empty-state'>No urgent work. Keep building product.</div>");
      refreshActionQueue(); // override with the real server exceptions queue

      renderRows("family-table", visible.map(function (family) {
        var rowId = familyRowId(family);
        var kids = childrenOf(family);
        var child = kids[0] || family;
        var locked = familyLocked(family);
        var deleted = familyDeleted(family);
        var subscriptionActive = familySubscriptionActive(family);
        var studentCount = kids.length || (family.studentName ? 1 : 0);
        var detail = kids.length
          ? "<div class='family-detail-grid'>" + kids.map(function (kid) {
              var u = usageToday(kid);
              return "<div class='family-detail-kid'>" +
                "<strong>" + text(kid.studentName || "Student") + "</strong>" +
                "<span>Grade: " + text(kid.grade || "—") + "</span>" +
                "<span>Learning level: " + text(kid.readingLevel || "—") + "</span>" +
                "<span>Today: " + u.math + " math, " + u.voiceMin + " min voice</span>" +
                "<span>Goals: " + ((kid.learningGoals && kid.learningGoals.length) || (kid.goal ? 1 : 0)) + "</span>" +
              "</div>";
            }).join("") + "</div>"
          : "<div class='family-detail-empty'>No student profiles yet.</div>";
        var planType = familySubscriptionLabel(family);
        var risk = familyRisk(family);
        var next = familyNextAction(family);
        return "<tr class='family-row' data-family-expand='" + rowId + "'>" +
          "<td class='expand-cell'><i data-lucide='chevron-right'></i></td>" +
          "<td>" + text(family.parentName) + "</td>" +
          "<td>" + text(family.email) + "</td>" +
          "<td>" + text(familyLoginType(family)) + "</td>" +
          "<td>" + studentCount + "</td>" +
          "<td>" + planType + "</td>" +
          "<td>" + statusChip(locked ? "locked" : family.subscriptionStatus) + "</td>" +
          "<td>" + text(familyNextRenewal(family)) + "</td>" +
          "<td>" + statusChip(risk.status) + "<small>" + escapeHtml(risk.label) + "</small></td>" +
          "<td><strong class='next-action-label'>" + escapeHtml(next.label) + "</strong><small>" + escapeHtml(next.detail) + "</small></td>" +
          "<td>" + text(shortDate(family.createdAt)) + "</td>" +
          "<td>" + rowDateTime(family.lastLoginAt) + "</td>" +
          "<td>" + rowDateTime(family.lastExtensionUseAt) + "</td>" +
          "<td><div class='row-actions'>" +
            "<button type='button' class='table-action' data-customer-open data-family-id='" + rowId + "'>View</button>" +
            "<button type='button' class='table-action " + (locked ? "" : "danger") + "' data-user-action='toggle-lock' data-family-id='" + rowId + "'" + (deleted ? " disabled" : "") + ">" + (locked ? "Unlock" : "Lock") + "</button>" +
            "<button type='button' class='table-action " + (subscriptionActive ? "danger" : "") + "' data-user-subscription-toggle data-family-id='" + rowId + "' data-subscription-action='" + (subscriptionActive ? "end" : "start") + "'" + (deleted ? " disabled" : "") + ">" + (subscriptionActive ? "Pause" : "Start") + "</button>" +
          "</div></td>" +
        "</tr>" +
        "<tr class='family-detail-row' data-family-detail='" + rowId + "' hidden><td colspan='14'>" + detail + "</td></tr>";
      }));

      populateExceptionFamilies();
      renderExceptionLog();
      renderAiUsageTable();
      loadIssues();

      renderMarkup("entitlement-rules", [
        ruleMarkup("Stripe paid subscription unlocks extension", "Extension should call GET /api/entitlements/me before loading tools.", "active", "shield-check"),
        ruleMarkup("Parent owns child profiles", "No teacher workflow required. Parent controls goals, rewards, and subscription.", "active", "users-round"),
        ruleMarkup("Paused or cancelled blocks premium tools", "Keep login available, but limit tool launch until billing is active.", "ready", "lock"),
        ruleMarkup("Promotion price overrides checkout", "Matching active promotions apply a Stripe discount to the selected plan.", "active", "badge-percent")
      ].join(""));

      var cancellationRows = families.filter(function (family) {
        return (family.cancellationRequested || family.subscriptionStatus === "cancel_scheduled") &&
          dateInRange(family.cancelRequestedAt || family.updatedAt || family.createdAt, cancellationFrom, cancellationTo);
      });
      setMetric("cancellation-request-count", cancellationRows.length + " open");
      setMetric("payment-toggle-cancellations", cancellationRows.length);
      renderRows("cancellation-request-table", cancellationRows.length ? cancellationRows.map(function (family) {
        var subscriptionId = family.cancellationSubscriptionId || family.stripeSubscriptionId || "";
        return "<tr>" +
          "<td>" + text(family.parentName) + "<small>" + text(family.email) + "</small></td>" +
          "<td>" + text(family.plan || moneyPlan()) + "</td>" +
          "<td>" + text(family.cancelReason || "Parent requested cancellation") + "</td>" +
          "<td>" + rowDateTime(family.cancelRequestedAt) + "</td>" +
          "<td>" + rowDateTime(family.cancelAccessUntil || family.cancellationAccessUntil) + "</td>" +
          "<td>" + (family.retentionOffer && family.retentionOffer.status ? escapeHtml(family.retentionOffer.status) : String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "Renewal only" : "Save offer") + "</td>" +
          "<td><a class='stripe-link payment-id-link' href='https://dashboard.stripe.com/test/subscriptions/" + encodeURIComponent(subscriptionId) + "' target='_blank' rel='noreferrer'>" + text(subscriptionId || "-") + "</a></td>" +
          "<td>" + statusChip(family.cancellationStatus || family.subscriptionStatus) + "</td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button></td>" +
        "</tr>";
      }) : ["<tr><td colspan='9'>No scheduled cancellation requests.</td></tr>"]);

      var yearlyUpgradeRows = families.filter(function (family) {
        var upgrade = family.yearlyUpgrade || {};
        return upgrade.status === "scheduled" &&
          dateInRange(upgrade.acceptedAt || upgrade.chargedAt || stripeUnixIso(upgrade.yearlyNextRenewalAt || upgrade.yearlyTrialEnd), upgradeFrom, upgradeTo);
      });
      setMetric("payment-toggle-upgrades", yearlyUpgradeRows.length);
      renderRows("yearly-upgrade-table", yearlyUpgradeRows.length ? yearlyUpgradeRows.map(function (family) {
        var upgrade = family.yearlyUpgrade || {};
        var monthlyIds = Array.isArray(upgrade.monthlySubscriptionIds) ? upgrade.monthlySubscriptionIds.join(", ") : "-";
        return "<tr>" +
          "<td>" + text(family.parentName) + "<small>" + text(family.email) + "</small></td>" +
          "<td><a class='stripe-link payment-id-link' href='https://dashboard.stripe.com/test/subscriptions/" + encodeURIComponent(monthlyIds.split(", ")[0] || "") + "' target='_blank' rel='noreferrer'>" + text(monthlyIds) + "</a></td>" +
          "<td><a class='stripe-link payment-id-link' href='https://dashboard.stripe.com/test/subscriptions/" + encodeURIComponent(upgrade.yearlySubscriptionId || "") + "' target='_blank' rel='noreferrer'>" + text(upgrade.yearlySubscriptionId || "-") + "</a></td>" +
          "<td>" + stripeUnixDateTime(upgrade.monthlyEndsAt) + "</td>" +
          "<td>" + stripeUnixDateTime(upgrade.yearlyNextRenewalAt || upgrade.yearlyTrialEnd) + "</td>" +
          "<td>" + text(upgrade.accessMonths || 12 + Number(upgrade.bonusMonths || 0)) + " months</td>" +
          "<td>" + statusChip(upgrade.status || "scheduled") + "</td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button></td>" +
        "</tr>";
      }) : ["<tr><td colspan='8'>No scheduled yearly upgrades.</td></tr>"]);

      var cancelledRows = families.filter(function (family) {
        return (family.subscriptionStatus === "cancelled" || family.cancellationStatus === "completed" || family.cancelledAt || family.cancellationCompletedAt) &&
          dateInRange(family.cancelledAt || family.cancellationCompletedAt || family.cancelAccessUntil || family.cancellationAccessUntil, cancelledFrom, cancelledTo);
      });
      setMetric("payment-toggle-cancelled", cancelledRows.length);
      var renewalRows = upcomingRenewals(families);
      var renewalValue = renewalRows.reduce(function (total, row) { return total + row.amountCents; }, 0);
      setMetric("renewal-value", money(renewalValue / 100));
      var renewalTotal = document.getElementById("renewal-total");
      if (renewalTotal) {
        renewalTotal.textContent = renewalRows.length
          ? renewalRows.length + " renewing · " + money(renewalValue / 100) + " expected"
          : "";
      }
      renderRows("renewal-table", renewalRows.length ? renewalRows.map(function (row) {
        var family = row.family;
        var label = row.onTrial
          ? (family.stripeSubscriptionId ? "Trial converting" : "Trial (no card)")
          : (String(family.plan || "").toLowerCase().indexOf("year") >= 0 ? "Yearly" : "Monthly");
        return "<tr>" +
          "<td>" + text(family.parentName) + "</td>" +
          "<td>" + text(family.email) + "</td>" +
          "<td>" + text(label) + "</td>" +
          "<td>" + statusChip(family.subscriptionStatus) + "</td>" +
          "<td>" + rowDateTime(row.iso) + "</td>" +
          "<td>" + (row.days === 0 ? "Today" : row.days + (row.days === 1 ? " day" : " days")) + "</td>" +
          // A comped trial collects nothing when it ends, so show why rather
          // than a misleading $0.
          "<td>" + (row.amountCents ? money(row.amountCents / 100) : "<span class='muted-cell'>no card</span>") + "</td>" +
          "<td>" + (family.id ? "<button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button>" : "-") + "</td>" +
        "</tr>";
      }) : ["<tr><td colspan='8'><div class='empty-state'>No renewals in this window.</div></td></tr>"]);

      renderRows("cancelled-subscription-table", cancelledRows.length ? cancelledRows.map(function (family) {
        var subscriptionId = family.cancellationSubscriptionId || family.stripeSubscriptionId || "";
        return "<tr>" +
          "<td>" + text(family.parentName) + "<small>" + text(family.email) + "</small></td>" +
          "<td>" + text(family.plan || moneyPlan()) + "</td>" +
          "<td>" + text(family.cancelReason || "Cancelled") + "</td>" +
          "<td>" + rowDateTime(family.cancelRequestedAt) + "</td>" +
          "<td>" + rowDateTime(family.cancelledAt || family.cancellationCompletedAt) + "</td>" +
          "<td>" + rowDateTime(family.cancelAccessUntil || family.cancellationAccessUntil) + "</td>" +
          "<td><a class='stripe-link payment-id-link' href='https://dashboard.stripe.com/test/subscriptions/" + encodeURIComponent(subscriptionId) + "' target='_blank' rel='noreferrer'>" + text(subscriptionId || "-") + "</a></td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button></td>" +
        "</tr>";
      }) : ["<tr><td colspan='8'>No cancelled subscriptions in this date range.</td></tr>"]);

      var paymentRows = filteredPaymentRecords(families);
      setMetric("payment-toggle-payments", paymentRows.length);
      paymentTableButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.paymentTable === activePaymentTable);
      });
      paymentTablePanels.forEach(function (panel) {
        panel.hidden = panel.dataset.paymentTablePanel !== activePaymentTable;
      });
      renderRows("payment-table", paymentRows.flatMap(function (paymentRow) {
        var family = paymentRow.family || {};
        var payment = paymentRow.payment || {};
        var plan = paymentRow.plan || moneyPlan();
        var paymentId = payment.paymentId || payment.id || "-";
        var rowId = family.id ? familyRowId(family) : cleanStripeSuffix(payment.email || paymentId);
        var status = payment.status || "paid";
        var amountCents = Number(payment.amountCents || 0);
        var reconciliation = reconciliationIssues(family);
        var row = "<tr class='" + (expandedPayment && expandedPayment.familyId === rowId ? "is-expanded" : "") + "'>" +
          "<td>" + rowDateTime(payment.createdAt) + "</td>" +
          "<td><strong>" + text(family.parentName || payment.email) + "</strong><small>" + text(family.email || payment.email) + "</small></td>" +
          "<td>" + text(plan) + "</td>" +
          "<td>" + moneyFromCents(amountCents) + "</td>" +
          "<td>" + statusChip(status) + "</td>" +
          "<td><a class='stripe-link payment-id-link' href='" + stripePaymentUrl(paymentId) + "' target='_blank' rel='noreferrer'>" + paymentId + "</a></td>" +
          "<td>" + (reconciliation.length ? statusChip("warning") + "<small>" + escapeHtml(reconciliation[0]) + "</small>" : "<span class='muted-cell'>Matched</span>") + "</td>" +
          "<td><div class='row-actions'><button type='button' class='table-action' data-customer-open data-family-id='" + rowId + "'" + (!family.id ? " disabled" : "") + ">View</button><button type='button' class='table-action' data-payment-expand='email' data-family-id='" + rowId + "'" + (!family.id ? " disabled" : "") + ">Email</button><button type='button' class='table-action danger' data-payment-expand='refund' data-family-id='" + rowId + "'" + (!family.id ? " disabled" : "") + ">Refund</button></div></td>" +
        "</tr>";
        if (family.id && expandedPayment && expandedPayment.familyId === rowId) {
          return [row, paymentDetailRow(family, expandedPayment.action, paymentId, amountCents)];
        }
        return [row];
      }).concat(paymentRows.length ? [] : ["<tr><td colspan='8'><div class='empty-state'>No payments yet. Real Stripe charges appear here once they are collected.</div></td></tr>"]));

      renderRows("exception-table", filteredExceptions(families).map(function (family) {
        var rowId = familyRowId(family);
        var health = familyHealth(family);
        return "<tr data-exception-row='" + rowId + "'>" +
          "<td><strong>" + text(family.parentName) + "</strong><small>" + text(family.email) + "</small></td>" +
          "<td>" + text(family.plan || moneyPlan()) + "<small>" + text(family.subscriptionStatus) + " · " + text(paymentStatus(family)) + "</small></td>" +
          "<td>" + statusChip(health.status) + "<small>" + health.label + "</small></td>" +
          "<td>" + exceptionStatusText(family) + "</td>" +
          "<td>" + recommendedException(family) + "</td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + rowId + "'>View</button></td>" +
        "</tr>";
      }));
      populateExceptionFamilies();
      refreshExceptionComposer();

      renderRows("usage-table", families.flatMap(function (family, familyIndex) {
        return childrenOf(family).map(function (child, index) {
          var today = usageToday(child);
          var favTool = family.favoriteTool || favoriteTool(family, familyIndex + index);
          var since = daysSinceActivity(family);
          return "<tr><td><strong>" + text(child.studentName) + "</strong><small>" + text(family.parentName) + "</small></td><td>" + text(child.grade) + "</td><td>" + today.math + "</td><td>" + today.voiceMin + " min</td><td>" + text(favTool) + "</td><td>" + (since === 0 ? "Today" : since + " days ago") + "</td></tr>";
        });
      }));

      renderRows("email-table", [
        ["Welcome parent", "Parent", "Signup complete", "active"],
        ["Payment failed", "Parent", "Stripe invoice failed", "active"],
        ["Weekly progress", "Parent", "Every Friday", "active"],
        ["Goal completed", "Parent", "Student reward earned", "draft"],
        ["Trial rescue", "Parent", "Inactive for 7 days", "active"],
        ["Winback offer", "Parent", "Cancellation requested", "draft"]
      ].map(function (row) {
        return "<tr><td><strong>" + row[0] + "</strong></td><td>" + row[1] + "</td><td>" + row[2] + "</td><td>" + statusChip(row[3]) + "</td><td><button type='button' class='table-action' data-template-email='" + row[0] + "'>Test</button></td></tr>";
      }));

      renderMarkup("journey-list", [
        ruleMarkup("Signup -> payment -> extension activation", "Send a nudge if checkout is not completed within 24 hours.", "active", "route"),
        ruleMarkup("Weekly parent progress email", "Summarize goals, tool usage, and earned rewards every Friday.", "active", "mail-check"),
        ruleMarkup("Payment recovery", "Retry failed payment and send parent a simple billing link.", "active", "credit-card"),
        ruleMarkup("Low usage rescue", "After 7 quiet days, suggest one tool based on grade and goal.", "ready", "activity")
      ].join(""));

      renderMarkup("retention-score", "<div class='retention-meter'><strong>" + percent(families.length - riskFamilies.length, families.length) + "</strong><span>accounts not at risk</span></div><p>" + riskFamilies.length + " families need a human or automated save attempt.</p>");
      renderMarkup("save-playbook", [
        ruleMarkup("Too expensive", "Offer 50% off for 1 month, then collect missing feature reason.", "active", "badge-percent"),
        ruleMarkup("Not using it enough", "Send a grade-specific starter mission and parent setup offer.", "active", "target"),
        ruleMarkup("Missing feature", "Capture request, tag family, and offer beta access if relevant.", "ready", "message-square")
      ].join(""));

      renderRows("cancellation-table", families.filter(function (family) {
        return family.subscriptionStatus === "cancelled" || family.subscriptionStatus === "paused" || familyHealth(family).score < 60;
      }).map(function (family, index) {
        var reason = family.subscriptionStatus === "cancelled" ? "Low usage" : family.paymentStatus === "failed" ? "Payment issue" : index % 2 === 0 ? "Too expensive" : "Not using it enough";
        var offer = reason === "Too expensive" ? "50% off for 1 month" : reason === "Payment issue" ? "Update card link" : "Starter mission";
        return "<tr><td><strong>" + text(family.parentName) + "</strong><small>" + text(family.email) + "</small></td><td>" + reason + "</td><td>" + offer + "</td><td>" + statusChip(family.subscriptionStatus) + "</td><td><button type='button' class='table-action' data-retention-email='" + familyRowId(family) + "'>Send save</button></td></tr>";
      }));

      renderRows("deletion-table", pendingDeletes.length ? pendingDeletes.map(function (family) {
        var rowId = familyRowId(family);
        var child = childrenOf(family)[0] || family;
        var status = deletionStatus(family);
        var billingRefs = [family.stripeCustomerId, family.stripeSubscriptionId, family.deletedEmail].filter(Boolean).map(escapeHtml).join("<small></small>") || "-";
        var actions = "<div class='row-actions privacy-row-actions'>" +
          "<button type='button' class='table-action' data-customer-open data-family-id='" + rowId + "'>View</button>" +
          (!familyLocked(family) && status !== "anonymized" ? "<button type='button' class='table-action' data-user-action='lock' data-family-id='" + rowId + "'>Lock</button>" : "") +
          "<button type='button' class='table-action danger' data-privacy-action='anonymize' data-family-id='" + rowId + "'" + (status === "anonymized" ? " disabled" : "") + ">Anonymize</button>" +
        "</div>";
        return "<tr>" +
          "<td>" + escapeHtml(text(family.parentName)) + "<small>" + escapeHtml(text(family.email)) + "</small>" + actions + "</td>" +
          "<td>" + escapeHtml(text(child.studentName || family.studentName)) + "<small>" + escapeHtml(text(child.grade || family.grade)) + "</small></td>" +
          "<td>" + escapeHtml(text(family.plan || moneyPlan())) + "<small>" + escapeHtml(text(family.subscriptionStatus)) + "</small></td>" +
          "<td>" + rowDateTime(family.deletionRequestedAt || family.anonymizedAt || family.deletionCompletedAt) + "</td>" +
          "<td>" + statusChip(status) + (familyLocked(family) ? "<small>Access locked</small>" : "<small>Lock before processing</small>") + "</td>" +
          "<td>" + billingRefs + "</td>" +
        "</tr>";
      }) : ["<tr><td colspan='6'><div class='empty-state'>No active deletion requests.</div></td></tr>"]);

      // Completed deletions, filtered by when they were anonymized.
      var deletedWindow = deletedDateFilter ? deletedDateFilter.value : "all";
      var deletedRows = anonymizedDeletes.filter(function (family) {
        return withinDateWindow(family.anonymizedAt || family.deletionCompletedAt, deletedWindow);
      });
      renderRows("deleted-table", deletedRows.length ? deletedRows.map(function (family) {
        var billingRefs = [family.stripeCustomerId, family.stripeSubscriptionId].filter(Boolean).map(escapeHtml).join("<small></small>") || "-";
        return "<tr>" +
          "<td>" + escapeHtml(text(family.email || family.deletedEmail)) + "</td>" +
          "<td>" + escapeHtml(text(family.plan || moneyPlan())) + "</td>" +
          "<td>" + rowDateTime(family.deletionRequestedAt) + "</td>" +
          "<td>" + rowDateTime(family.anonymizedAt || family.deletionCompletedAt) + "</td>" +
          "<td>" + billingRefs + "</td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button></td>" +
        "</tr>";
      }) : ["<tr><td colspan='6'><div class='empty-state'>No deleted accounts in this period.</div></td></tr>"]);

      var signupRows = filteredSignups(families);
      renderRows("signup-table", signupRows.length ? signupRows.map(function (family) {
        var days = family.createdAt
          ? Math.floor((Date.now() - new Date(family.createdAt).getTime()) / 86400000)
          : null;
        return "<tr>" +
          "<td>" + text(family.parentName) + "</td>" +
          "<td>" + text(family.email) + "</td>" +
          "<td>" + text(familyLoginType(family)) + "</td>" +
          "<td>" + childrenOf(family).length + "</td>" +
          "<td>" + statusChip(family.accountLocked ? "locked" : family.subscriptionStatus) + "</td>" +
          "<td>" + text(shortDate(family.createdAt)) + "</td>" +
          "<td>" + (days === null ? "—" : days === 0 ? "Today" : days + (days === 1 ? " day" : " days")) + "</td>" +
          "<td>" + text(family.lastLoginAt ? shortDate(family.lastLoginAt) : "Never") + "</td>" +
          "<td>" + escapeHtml(familyNextAction(family).label) + "</td>" +
          "<td><button type='button' class='table-action' data-customer-open data-family-id='" + familyRowId(family) + "'>View</button></td>" +
        "</tr>";
      }) : ["<tr><td colspan='10'><div class='empty-state'>No signups waiting to subscribe.</div></td></tr>"]);

      renderRows("trial-table", trialFamilies.length ? trialFamilies.map(function (family) {
        // Anything Stripe owns — including a cancelled trial still running out
        // its term — must not offer local delete: removing the family here would
        // leave a live Stripe subscription that still bills the customer.
        var stripeTrial = family.subscriptionStatus === "trialing" || Boolean(family.stripeSubscriptionId) || Boolean(family.trialUsedAt);
        var live = (family.subscriptionStatus === "trial" || stripeTrial) && new Date(family.trialEndsAt || 0).getTime() > Date.now();
        // A Stripe trial has no trialDays/trialStartedAt of its own — it is
        // defined by the subscription, so derive the length from the dates and
        // label it as card-on-file to distinguish it from an admin comp.
        var days = Number(family.trialDays) || 0;
        if (!days && stripeTrial && family.trialEndsAt) {
          var startMs = new Date(family.trialUsedAt || family.createdAt || Date.now()).getTime();
          days = Math.max(1, Math.round((new Date(family.trialEndsAt).getTime() - startMs) / 86400000));
        }
        return "<tr>" +
          "<td>" + escapeHtml(text(family.parentName)) + "</td>" +
          "<td>" + escapeHtml(text(family.email)) + "</td>" +
          "<td>" + (days ? days + " days" : "—") + (stripeTrial ? " <small>card on file</small>" : "") + "</td>" +
          "<td>" + rowDateTime(family.trialStartedAt || family.trialUsedAt) + "</td>" +
          "<td>" + rowDateTime(family.trialEndsAt) + "</td>" +
          "<td>" + statusChip(live && !stripeTrial ? "active" : family.subscriptionStatus) + "</td>" +
          "<td><div class='row-actions'>" +
            (stripeTrial ? "<span class='muted-note'>Stripe</span>" : "<button type='button' class='table-action danger' data-trial-delete='" + escapeHtml(family.id) + "'>Delete</button>") +
          "</div></td>" +
        "</tr>";
      }) : ["<tr><td colspan='7'><div class='empty-state'>No trial accounts yet.</div></td></tr>"]);

      renderMarkup("privacy-rules", [
        ruleMarkup("Lock account first", "Parent deletion request locks extension access immediately while admin reviews billing.", "active", "lock"),
        ruleMarkup("Handle Stripe separately", "Cancel subscription, refund, or export Stripe receipts before anonymizing local data.", "ready", "credit-card"),
        ruleMarkup("Anonymize local PII", "Admin action replaces parent email with the next deleted_user_xxxxx@deleted.local address.", "active", "shield-user"),
        ruleMarkup("Keep audit trail", "Logs and payments remain for business records after direct identifiers are scrubbed.", "ready", "list-checks")
      ].join(""));

      renderRows("logs-table", filteredLogs().map(function (log) {
        return "<tr>" +
          "<td>" + rowDateTime(log.createdAt) + "</td>" +
          "<td>" + escapeHtml(logActor(log)) + "</td>" +
          "<td>" + statusChip(logCategory(log)) + "<small>" + escapeHtml(String(log.action || "").replace(/_/g, " ")) + "</small></td>" +
          "<td>" + escapeHtml(logEmail(log) || "-") + "</td>" +
          "<td>" + escapeHtml(logDetail(log)) + "</td>" +
        "</tr>";
      }));

      renderRows("monitor-table", monitorEventsCache.length ? monitorEventsCache.slice(0, 50).map(function (event) {
        return "<tr>" +
          "<td>" + rowDateTime(event.createdAt) + "</td>" +
          "<td>" + statusChip(event.severity || "info") + "</td>" +
          "<td>" + escapeHtml(text(event.category)) + "</td>" +
          "<td>" + escapeHtml(text(event.message)) + "<small>" + escapeHtml(payloadSummary(event.payload)) + "</small></td>" +
          "<td>" + escapeHtml(text(event.actor)) + "</td>" +
        "</tr>";
      }) : ["<tr><td colspan='5'><div class='empty-state'>No monitoring alerts yet.</div></td></tr>"]);

      renderMarkup("automation-list", actions.length ? actions.map(function (item) {
        return "<div class='automation-item'>" + actionItemMarkup(item) + "<button type='button' class='table-action' data-automation-action='" + item.action + "' data-family-id='" + item.familyId + "'>Run</button></div>";
      }).join("") : "<div class='empty-state'>Autopilot has no pending safe tasks.</div>");

      renderMarkup("ops-readiness-list", [
        ruleMarkup("Stripe developer mode", "Checkout, refund, pause, and cancel endpoints are available.", "active", "badge-dollar-sign"),
        ruleMarkup("Email provider", "SMTP is mocked until production credentials are configured.", "pending", "mail"),
        ruleMarkup("Authentication", "Demo login exists. Replace with production auth before public launch.", "pending", "lock"),
        ruleMarkup("Entitlement API", "Extension should validate active subscription before tool access.", "ready", "key-round")
      ].join(""));

      renderMarkup("operator-timeline", [
        "Demo data refreshed",
        "Pricing synced with parent portal",
        "Autopilot scanned billing and usage",
        "Admin console rebuilt for solo operations"
      ].map(function (item, index) {
        return "<div><span>" + (index + 1) + "</span><strong>" + item + "</strong><small>" + rowDate({ createdAt: new Date(Date.now() - index * 3600000).toISOString() }) + "</small></div>";
      }).join(""));

      renderMarkup("launch-checklist", [
        ["Stripe checkout and refunds", "Verified in developer mode", "active"],
        ["Parent onboarding portal", "Ready for demo flow", "active"],
        ["Admin family operations", "Pause, cancel, email, refund controls wired", "active"],
        ["Production email sending", "Needs SMTP or provider credentials", "pending"],
        ["Production authentication", "Needs managed auth provider", "pending"],
        ["Extension entitlement check", "Wire /api/entitlements/me before launch", "ready"]
      ].map(function (item) {
        return "<label class='launch-check'><input type='checkbox' " + (item[2] === "active" ? "checked" : "") + " disabled><span><strong>" + item[0] + "</strong><small>" + item[1] + "</small></span>" + statusChip(item[2]) + "</label>";
      }).join(""));

      renderMarkup("release-controls", [
        ruleMarkup("Current extension", "KiddieGPT extension package exists locally for Chrome testing.", "active", "panel-right"),
        ruleMarkup("Tool coverage", "Math, PDF, flashcards, reading, graph, quiz flows represented in admin usage.", "active", "boxes"),
        ruleMarkup("Guardrail posture", "Explain-first and no direct homework-answer principles should stay enforced.", "ready", "shield"),
        ruleMarkup("Post-launch watchlist", "Track failed payments, inactive students, and cancellation reasons daily.", "active", "radar")
      ].join(""));

      renderIcons();
      refreshDevStatus();
    }

    navButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setAdminView(button.dataset.adminView);
      });
    });

    search.addEventListener("input", renderAdmin);
    statusFilter.addEventListener("change", renderAdmin);
    if (lockedFilter) lockedFilter.addEventListener("change", renderAdmin);
    if (trialForm) {
      trialForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var state = document.getElementById("trial-form-state");
        var setState = function (label, cls) {
          if (!state) return;
          state.textContent = label;
          state.className = "state-chip " + (cls || "ready");
        };
        setState("Starting", "warning");
        try {
          var response = await apiFetch("/api/admin/trials", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: trialForm.elements.name.value.trim(),
              email: trialForm.elements.email.value.trim(),
              days: Number(trialForm.elements.days.value)
            })
          });
          var result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not start the trial.");
          trialForm.reset();
          setState("Trial started", "ok");
          await loadBackendState();
          renderAdmin();
        } catch (error) {
          setState(error.message || "Could not start", "error");
        }
      });
    }

    // One delegated listener covers every admin table, including any added later.
    document.addEventListener("click", function (event) {
      var th = event.target.closest ? event.target.closest("thead th") : null;
      if (!th) return;
      var table = th.closest("table");
      var body = table && table.querySelector("tbody[id]");
      if (!body) return;
      // The expand chevron column has no content to sort by.
      if (!th.textContent.trim()) return;
      var index = Array.prototype.indexOf.call(th.parentElement.children, th);
      var current = tableSortState[body.id];
      tableSortState[body.id] = {
        index: index,
        dir: current && current.index === index && current.dir === "asc" ? "desc" : "asc"
      };
      applyTableSort(body.id);
      markSortedHeader(body.id);
    });

    document.addEventListener("click", async function (event) {
      var button = event.target.closest ? event.target.closest("[data-trial-delete]") : null;
      if (!button) return;
      var familyId = button.dataset.trialDelete;
      var row = button.closest("tr");
      var email = row ? (row.children[1] || {}).textContent : "";
      if (!window.confirm("Delete the trial account for " + (email || "this parent") + "? This cannot be undone.")) return;
      button.disabled = true;
      try {
        var response = await apiFetch("/api/admin/trials/" + encodeURIComponent(familyId), { method: "DELETE" });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not delete the trial.");
        await loadBackendState();
        renderAdmin();
      } catch (error) {
        button.disabled = false;
        var state = document.getElementById("trial-form-state");
        if (state) {
          state.textContent = error.message || "Could not delete";
          state.className = "state-chip error";
        }
      }
    });

    if (maxAiFilter) maxAiFilter.addEventListener("change", renderAdmin);
    if (subscriptionFilter) subscriptionFilter.addEventListener("change", renderAdmin);
    if (signupSearch) signupSearch.addEventListener("input", renderAdmin);
    if (signupDateFilter) signupDateFilter.addEventListener("change", renderAdmin);
    if (renewalSubscriptionFilter) renewalSubscriptionFilter.addEventListener("change", renderAdmin);
    if (renewalWindowFilter) renewalWindowFilter.addEventListener("change", renderAdmin);
    if (paidDateFilter) paidDateFilter.addEventListener("change", renderAdmin);
    if (deletedDateFilter) deletedDateFilter.addEventListener("change", renderAdmin);
    if (paymentSearch) paymentSearch.addEventListener("input", renderAdmin);
    if (paymentStatusFilter) paymentStatusFilter.addEventListener("change", renderAdmin);
    if (paymentPlanFilter) paymentPlanFilter.addEventListener("change", renderAdmin);
    [cancellationFrom, cancellationTo, upgradeFrom, upgradeTo, cancelledFrom, cancelledTo, paymentFrom, paymentTo].forEach(function (input) {
      if (input) input.addEventListener("change", renderAdmin);
    });
    paymentTableButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        activePaymentTable = button.dataset.paymentTable || "payments";
        expandedPayment = null;
        renderAdmin();
      });
    });
    familyTableButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        activeFamilyTable = button.dataset.familyTable || "accounts";
        renderAdmin();
      });
    });
    if (logSearch) logSearch.addEventListener("input", renderAdmin);
    if (logTypeFilter) logTypeFilter.addEventListener("change", renderAdmin);
    if (exceptionSearch) exceptionSearch.addEventListener("input", renderAdmin);
    if (exceptionStatusFilter) exceptionStatusFilter.addEventListener("change", renderAdmin);
    if (exceptionParentSearch) {
      exceptionParentSearch.addEventListener("input", function () {
        populateExceptionFamilies();
        refreshExceptionComposer();
      });
    }
    if (exceptionFamilySelect) {
      exceptionFamilySelect.addEventListener("change", function () {
        selectedExceptionFamilyId = exceptionFamilySelect.value;
        refreshExceptionComposer();
      });
    }
    if (pricingForm.elements.planSetupKey) {
      Array.from(pricingForm.elements.planSetupKey).forEach(function (input) {
        input.addEventListener("change", syncPlanSetupFields);
      });
    }
    [exceptionActionSelect, exceptionAmount, exceptionMonths, exceptionDays, exceptionPercent].forEach(function (control) {
      if (control) control.addEventListener("input", refreshExceptionComposer);
      if (control) control.addEventListener("change", refreshExceptionComposer);
    });
    if (seedButton) {
      seedButton.addEventListener("click", function () {
        seedFamilies();
        selectedFamilyId = null;
        renderAdmin();
      });
    }

    var dismissAbuseBtn = document.getElementById("dismiss-abuse");
    if (dismissAbuseBtn) {
      dismissAbuseBtn.addEventListener("click", function () {
        dismissAbuseAlerts();
      });
    }

    var runSweepBtn = document.getElementById("run-sweep-now");
    if (runSweepBtn) runSweepBtn.addEventListener("click", runSweepNow);
    var saveRulesBtn = document.getElementById("save-autopilot-rules");
    if (saveRulesBtn) saveRulesBtn.addEventListener("click", saveAutopilotRules);
    var saveEmailBtn = document.getElementById("save-email-settings");
    if (saveEmailBtn) saveEmailBtn.addEventListener("click", function () { saveEmailSettings(false); });
    var clearPostmarkBtn = document.getElementById("clear-postmark-token");
    if (clearPostmarkBtn) clearPostmarkBtn.addEventListener("click", function () { saveEmailSettings(true); });
    var emailGalleryEl = document.getElementById("email-template-gallery");
    if (emailGalleryEl) emailGalleryEl.addEventListener("click", function (event) {
      var pv = event.target.closest("[data-email-preview]");
      if (pv) {
        var key = pv.dataset.emailPreview;
        var box = document.getElementById("email-preview-" + key);
        if (!box) return;
        if (!box.hidden) { box.hidden = true; box.innerHTML = ""; pv.textContent = "Preview"; return; }
        var tpl = emailTemplatesCache.filter(function (t) { return t.key === key; })[0];
        if (tpl) {
          var iframe = document.createElement("iframe");
          iframe.className = "email-preview-frame";
          iframe.setAttribute("title", tpl.name + " preview");
          iframe.srcdoc = tpl.html;
          box.innerHTML = "";
          box.appendChild(iframe);
          box.hidden = false;
          pv.textContent = "Hide";
        }
        return;
      }
      var test = event.target.closest("[data-email-test]");
      if (test) sendTemplateTest(test.dataset.emailTest, test);
    });
    var applyExceptionBtn = document.getElementById("apply-exception");
    if (applyExceptionBtn) applyExceptionBtn.addEventListener("click", applyException);
    var issueTypeFilter = document.getElementById("issue-type-filter");
    if (issueTypeFilter) issueTypeFilter.addEventListener("change", renderIssues);
    var digestRefreshBtn = document.getElementById("digest-refresh");
    if (digestRefreshBtn) digestRefreshBtn.addEventListener("click", loadLogDigest);
    var digestRangeEl = document.getElementById("digest-range");
    if (digestRangeEl) digestRangeEl.addEventListener("change", loadLogDigest);
    var issuesTable = document.getElementById("issues-table");
    if (issuesTable) issuesTable.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-issue-resolve]");
      if (btn) resolveIssue(btn.dataset.issueResolve);
    });
    var supportListEl = document.getElementById("support-list");
    if (supportListEl) supportListEl.addEventListener("click", function (event) {
      var item = event.target.closest("[data-support-email]");
      if (!item) return;
      selectedSupportEmail = item.dataset.supportEmail;
      renderSupportList();
      renderSupportConversation();
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-support-filter]"), function (pill) {
      pill.addEventListener("click", function () {
        supportFilter = pill.dataset.supportFilter;
        Array.prototype.forEach.call(document.querySelectorAll("[data-support-filter]"), function (p) {
          p.classList.toggle("active", p === pill);
        });
        selectedSupportEmail = "";
        var visible = filteredSupportConvos();
        if (visible.length) selectedSupportEmail = visible[0].email;
        renderSupportList();
        renderSupportConversation();
      });
    });
    var supportSearchEl = document.getElementById("support-search");
    if (supportSearchEl) supportSearchEl.addEventListener("input", function () {
      supportSearch = supportSearchEl.value;
      renderSupportList();
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-support-topic]"), function (pill) {
      pill.addEventListener("click", function () {
        supportTopic = pill.dataset.supportTopic;
        Array.prototype.forEach.call(document.querySelectorAll("[data-support-topic]"), function (p) {
          p.classList.toggle("active", p === pill);
        });
        selectedSupportEmail = "";
        var visible = filteredSupportConvos();
        if (visible.length) selectedSupportEmail = visible[0].email;
        renderSupportList();
        renderSupportConversation();
      });
    });
    var supportFromEl = document.getElementById("support-from");
    if (supportFromEl) supportFromEl.addEventListener("change", function () { supportFrom = supportFromEl.value; renderSupportList(); });
    var supportToEl = document.getElementById("support-to");
    if (supportToEl) supportToEl.addEventListener("change", function () { supportTo = supportToEl.value; renderSupportList(); });
    var supportRefreshButton = document.getElementById("support-refresh");
    if (supportRefreshButton) supportRefreshButton.addEventListener("click", function () {
      supportRefreshButton.classList.add("is-loading");
      loadSupportConversations().finally(function () { supportRefreshButton.classList.remove("is-loading"); });
    });

    document.addEventListener("click", async function (event) {
      var exportButton = event.target.closest ? event.target.closest("[data-export-table]") : null;
      if (exportButton) {
        exportAdminTable(exportButton.dataset.exportTable, exportButton.dataset.exportName);
        return;
      }
      var closeButton = event.target.closest ? event.target.closest("[data-customer-close]") : null;
      if (closeButton || event.target === customerDrawerBackdrop) {
        closeCustomerDrawer();
        return;
      }
      var openButton = event.target.closest ? event.target.closest("[data-customer-open]") : null;
      if (openButton) {
        openCustomerDrawer(openButton.dataset.familyId);
        return;
      }
      var saveButton = event.target.closest ? event.target.closest("[data-customer-save]") : null;
      if (saveButton) {
        var saveFamily = familyById(saveButton.dataset.familyId);
        if (!saveFamily) return;
        var drawerNotes = customerDrawerBody && customerDrawerBody.querySelector("[data-customer-notes]");
        var drawerTags = customerDrawerBody && customerDrawerBody.querySelector("[data-customer-tags]");
        saveButton.disabled = true;
        try {
          var saved = await patchFamilyOnBackend(familyRowId(saveFamily), {
            adminNote: drawerNotes ? drawerNotes.value.trim() : "",
            adminTags: drawerTags ? drawerTags.value.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean) : []
          });
          if (!saved) throw new Error("Could not save notes.");
          await loadBackendState();
          renderAdmin();
          openCustomerDrawer(familyRowId(saveFamily));
          writeDevOutput("Customer notes saved", { familyId: saveFamily.id, email: saveFamily.email });
        } catch (error) {
          writeDevOutput("Customer notes failed", error);
        } finally {
          saveButton.disabled = false;
        }
        return;
      }
      var customerActionButton = event.target.closest ? event.target.closest("[data-customer-action]") : null;
      if (!customerActionButton) return;
      var actionFamily = familyById(customerActionButton.dataset.familyId);
      if (!actionFamily) return;
      var customerAction = customerActionButton.dataset.customerAction;
      if (customerAction === "exception") {
        closeCustomerDrawer();
        activePaymentTable = "exceptions";
        setAdminView("billing");
        renderAdmin();
        selectedExceptionFamilyId = familyRowId(actionFamily);
        if (exceptionFamilySelect) exceptionFamilySelect.value = selectedExceptionFamilyId;
        refreshExceptionComposer();
        return;
      }
      customerActionButton.disabled = true;
      try {
        if (customerAction === "email") {
          await fetchJson("/api/admin/trigger-email", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: actionFamily.email, template: "Admin triggered parent email" })
          });
          writeDevOutput("Customer email sent", { email: actionFamily.email });
        } else if (customerAction === "lock") {
          await fetchJson("/api/admin/users/" + encodeURIComponent(familyRowId(actionFamily)) + "/lock", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locked: !familyLocked(actionFamily) })
          });
          await loadBackendState();
          renderAdmin();
          openCustomerDrawer(familyRowId(actionFamily));
        } else if (customerAction === "subscription") {
          var subscriptionAction = familySubscriptionActive(actionFamily) ? "end" : "start";
          await fetchJson("/api/admin/users/" + encodeURIComponent(familyRowId(actionFamily)) + "/subscription-toggle", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: subscriptionAction })
          });
          await loadBackendState();
          renderAdmin();
          openCustomerDrawer(familyRowId(actionFamily));
        }
      } catch (error) {
        writeDevOutput("Customer action failed", error);
      } finally {
        customerActionButton.disabled = false;
      }
      refreshDevStatus();
    });

    if (table) {
      table.addEventListener("click", function (event) {
        if (event.target.closest("button, a, input, .row-actions")) return; // don't hijack action buttons
        var row = event.target.closest("[data-family-expand]");
        if (!row) return;
        var detailRow = table.querySelector("[data-family-detail='" + row.dataset.familyExpand + "']");
        if (!detailRow) return;
        var opening = detailRow.hasAttribute("hidden");
        if (opening) detailRow.removeAttribute("hidden"); else detailRow.setAttribute("hidden", "");
        row.classList.toggle("expanded", opening);
      });
    }

    pricingForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var saveButton = pricingForm.querySelector('button[type="submit"]');
      // Saving a form that never loaded would write its blank defaults over the
      // live configuration. Repopulate and make the admin press Save again.
      if (!pricingFormSynced) {
        syncPricingForm();
        setPricingSaveState("Reloaded — review and save again", "warning");
        return;
      }
      setPricingSaveState("Saving", "warning");
      if (saveButton) saveButton.disabled = true;
      try {
        var pricing = readPricing();
        var setupKey = planSetupKey();
        var monthlyPlan = Object.assign({}, pricing.monthly);
        var yearlyPlan = Object.assign({}, pricing.yearly);
        var targetPlan = setupKey === "yearly" ? yearlyPlan : monthlyPlan;
        var promoMonthlyPrice = Number(pricingForm.elements.promoMonthlyPrice ? pricingForm.elements.promoMonthlyPrice.value : 0) || 0;
        var promoYearlyPrice = Number(pricingForm.elements.promoYearlyPrice ? pricingForm.elements.promoYearlyPrice.value : 0) || 0;
        var promoMonthlyCode = pricingForm.elements.promoMonthlyCode ? pricingForm.elements.promoMonthlyCode.value.trim() : "";
        var promoYearlyCode = pricingForm.elements.promoYearlyCode ? pricingForm.elements.promoYearlyCode.value.trim() : "";
        targetPlan.amount = Number(pricingForm.elements.planAmount.value) || Number(targetPlan.amount || 19);
        targetPlan.stripePriceId = pricingForm.elements.planStripePriceId.value.trim();
        targetPlan.familyMemberCount = Number(pricingForm.elements.planFamilyMemberCount.value) || Number(targetPlan.familyMemberCount || 3);
        await writePricing({
          monthly: monthlyPlan,
          yearly: yearlyPlan,
          // Merge onto the stored promotion rather than rebuilding it: fields
          // with no input on this screen (showAfterDays, durationDays) were
          // being reset to 0 by every unrelated save.
          promotion: Object.assign({}, pricing.promotion, {
            enabled: pricingForm.elements.promotionEnabled ? pricingForm.elements.promotionEnabled.checked : true,
            planKey: promoYearlyPrice > 0 && promoMonthlyPrice <= 0 ? "yearly" : "monthly",
            monthlyCode: promoMonthlyCode,
            yearlyCode: promoYearlyCode,
            code: promoMonthlyCode || promoYearlyCode,
            price: promoMonthlyPrice || promoYearlyPrice,
            monthlyAmount: promoMonthlyPrice,
            yearlyAmount: promoYearlyPrice,
            description: pricingForm.elements.promoDescription ? pricingForm.elements.promoDescription.value.trim() : ""
          }),
          yearlyUpgrade: {
            bonusMonths: Number(pricingForm.elements.upgradeBonusMonths ? pricingForm.elements.upgradeBonusMonths.value : 3) || 0,
            discountAmount: Number(pricingForm.elements.upgradeDiscountAmount ? pricingForm.elements.upgradeDiscountAmount.value : 0) || 0,
            note: pricingForm.elements.upgradeNote ? pricingForm.elements.upgradeNote.value.trim() : ""
          },
          cancellationPromo: {
            enabled: pricingForm.elements.cancellationPromoEnabled ? pricingForm.elements.cancellationPromoEnabled.checked : true,
            amountOff: Number(pricingForm.elements.cancellationPromoAmountOff ? pricingForm.elements.cancellationPromoAmountOff.value : 0) || 0,
            duration: pricingForm.elements.cancellationPromoDuration ? pricingForm.elements.cancellationPromoDuration.value : "once",
            description: pricingForm.elements.cancellationPromoDescription ? pricingForm.elements.cancellationPromoDescription.value.trim() : ""
          }
        });
        writeDevOutput("Pricing saved", readPricing());
        setPricingSaveState("Saved", "ok");
      } catch (error) {
        setPricingSaveState(error && error.error ? error.error : "Save failed", "error");
        writeDevOutput("Pricing save failed", error);
      }
      if (saveButton) saveButton.disabled = false;
      renderAdmin();
    });

    if (aiSettingsForm) {
      aiSettingsForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        await saveAiSettings(false);
      });
    }

    // Tutor voice shortlist: toggling a voice updates its chip + the default menu.
    var ttsVoiceListEl = document.getElementById("tts-voice-list");
    if (ttsVoiceListEl) {
      ttsVoiceListEl.addEventListener("change", function (event) {
        var box = event.target.closest('input[data-tts-voice]');
        if (!box) return;
        var label = box.closest("label");
        if (label) label.classList.toggle("is-checked", box.checked);
        var keepDefault = (document.getElementById("tts-default-voice") || {}).value;
        rebuildDefaultVoiceOptions(keepDefault);
      });
    }

    if (clearOpenaiKey) {
      clearOpenaiKey.addEventListener("click", async function () {
        await saveAiSettings(true);
      });
    }

    if (exceptionForm) {
      exceptionForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var payload;
        try {
          payload = exceptionPayloadFromForm();
        } catch (error) {
          writeExceptionOutput("Exception not ready", {
            action: exceptionActionSelect ? exceptionActionSelect.value : "billing_exception",
            error: error.message,
            message: error.message
          }, "Error");
          return;
        }
        if (exceptionApply) exceptionApply.disabled = true;
        if (exceptionActionState) {
          exceptionActionState.textContent = "Working";
          exceptionActionState.className = "state-chip warning";
        }
        writeExceptionOutput("Applying exception", {
          action: payload.action,
          email: payload.email,
          reason: payload.reason,
          message: "Applying " + exceptionActionLabel(payload.action) + " for " + payload.email + "."
        }, "Working");
        try {
          var exceptionResult = await fetchJson("/api/admin/billing-exception", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          var emailResult = null;
          if (exceptionSendEmail && exceptionSendEmail.checked && payload.action !== "send_save_email") {
            emailResult = await fetchJson("/api/admin/billing-exception", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "send_save_email",
                familyId: payload.familyId,
                email: payload.email,
                reason: "Follow-up after " + exceptionActionLabel(payload.action),
                message: payload.message
              })
            });
          }
          await loadBackendState();
          if (exceptionResult && emailResult) exceptionResult.followUpEmail = emailResult.email || emailResult.message;
          writeDevOutput("Billing exception", exceptionResult);
          writeExceptionOutput("Billing exception applied", exceptionResult, "Done");
          renderAdmin();
        } catch (error) {
          writeDevOutput("Billing exception failed", error);
          writeExceptionOutput("Billing exception failed", Object.assign({ action: payload.action, email: payload.email }, error || {}), "Error");
        } finally {
          if (exceptionApply) exceptionApply.disabled = false;
          if (exceptionActionState) {
            exceptionActionState.textContent = "Ready";
            exceptionActionState.className = "state-chip ready";
          }
        }
        refreshDevStatus();
      });
    }

    if (workspace) {
      workspace.addEventListener("click", async function (event) {
        var shortcut = event.target.closest("[data-admin-view-shortcut]");
        if (shortcut) {
          setAdminView(shortcut.dataset.adminViewShortcut);
          return;
        }

        var runAll = event.target.closest("[data-run-all-automations]");
        if (runAll) {
          var allActions = adminActions(readFamilies());
          writeDevOutput("Autopilot run", {
            mode: "mock",
            tasksRun: allActions.length,
            tasks: allActions.map(function (item) { return item.action; }),
            message: "Safe founder tasks were simulated. Wire this to jobs/email provider in production."
          });
          return;
        }

        var templateButton = event.target.closest("[data-template-email]");
        if (templateButton) {
          templateButton.disabled = true;
          try {
            var templatePayload = await fetchJson("/api/admin/trigger-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: "parent.kiddiegpt@gmail.com",
                template: templateButton.dataset.templateEmail
              })
            });
            writeDevOutput("Lifecycle template test", templatePayload);
          } catch (error) {
            writeDevOutput("Lifecycle template failed", error);
          } finally {
            templateButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var broadcastButton = event.target.closest("[data-broadcast-template]");
        if (broadcastButton) {
          broadcastButton.disabled = true;
          try {
            var activeFamilies = readFamilies().filter(function (family) { return family.subscriptionStatus === "active"; });
            var broadcastPayload = await fetchJson("/api/admin/trigger-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: activeFamilies[0] ? activeFamilies[0].email : "parent.kiddiegpt@gmail.com",
                template: broadcastButton.dataset.broadcastTemplate
              })
            });
            broadcastPayload.recipients = activeFamilies.length;
            writeDevOutput("Weekly summary broadcast", broadcastPayload);
          } catch (error) {
            writeDevOutput("Weekly summary failed", error);
          } finally {
            broadcastButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var retentionButton = event.target.closest("[data-retention-email]");
        if (retentionButton) {
          var retentionFamily = familyById(retentionButton.dataset.retentionEmail);
          if (!retentionFamily) return;
          retentionButton.disabled = true;
          try {
            var retentionPayload = await fetchJson("/api/admin/trigger-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: retentionFamily.email,
                template: "Retention save offer"
              })
            });
            writeDevOutput("Retention save email", retentionPayload);
          } catch (error) {
            writeDevOutput("Retention save failed", error);
          } finally {
            retentionButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var automationButton = event.target.closest("[data-automation-action]");
        if (automationButton) {
          var automationFamily = familyById(automationButton.dataset.familyId);
          if (!automationFamily) return;
          automationButton.disabled = true;
          try {
            var automationPayload = await fetchJson("/api/admin/trigger-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: automationFamily.email,
                template: automationButton.dataset.automationAction
              })
            });
            writeDevOutput("Autopilot task", automationPayload);
          } catch (error) {
            writeDevOutput("Autopilot task failed", error);
          } finally {
            automationButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var exceptionRow = event.target.closest("[data-exception-row]");
        if (exceptionRow && exceptionFamilySelect) {
          selectedExceptionFamilyId = exceptionRow.dataset.exceptionRow;
          exceptionFamilySelect.value = selectedExceptionFamilyId;
          refreshExceptionComposer();
          writeExceptionOutput("Parent selected", {
            action: exceptionActionSelect ? exceptionActionSelect.value : "billing_exception",
            email: selectedExceptionFamily() ? selectedExceptionFamily().email : "",
            reason: "Ready for action",
            message: "Choose an action and customize the amount or email before applying."
          }, "Ready");
          exceptionForm.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }

        var paymentExpandButton = event.target.closest("[data-payment-expand]");
        if (paymentExpandButton) {
          var expandFamily = familyById(paymentExpandButton.dataset.familyId);
          if (!expandFamily) return;
          var nextExpansion = {
            familyId: familyRowId(expandFamily),
            action: paymentExpandButton.dataset.paymentExpand
          };
          expandedPayment = expandedPayment &&
            expandedPayment.familyId === nextExpansion.familyId &&
            expandedPayment.action === nextExpansion.action ? null : nextExpansion;
          renderAdmin();
          return;
        }

        var paymentCloseButton = event.target.closest("[data-payment-close]");
        if (paymentCloseButton) {
          expandedPayment = null;
          renderAdmin();
          return;
        }

        var paymentTemplateButton = event.target.closest("[data-payment-template]");
        if (paymentTemplateButton) {
          var templateFamily = familyById(paymentTemplateButton.dataset.familyId);
          if (!templateFamily) return;
          var compose = document.querySelector("[data-payment-compose='" + familyRowId(templateFamily) + "']");
          var templates = paymentEmailTemplates(templateFamily);
          if (compose && templates[paymentTemplateButton.dataset.paymentTemplate]) {
            compose.value = templates[paymentTemplateButton.dataset.paymentTemplate];
          }
          return;
        }

        var paymentSendButton = event.target.closest("[data-payment-send]");
        if (paymentSendButton) {
          var sendFamily = familyById(paymentSendButton.dataset.familyId);
          if (!sendFamily) return;
          var composeBox = document.querySelector("[data-payment-compose='" + familyRowId(sendFamily) + "']");
          paymentSendButton.disabled = true;
          try {
            var paymentEmailPayload = await fetchJson("/api/admin/trigger-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: sendFamily.email,
                template: "Payment note",
                message: composeBox ? composeBox.value : ""
              })
            });
            writeDevOutput("Payment email sent", paymentEmailPayload);
          } catch (error) {
            writeDevOutput("Payment email failed", error);
          } finally {
            paymentSendButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var subscriptionToggleButton = event.target.closest("[data-user-subscription-toggle]");
        if (subscriptionToggleButton) {
          var subscriptionFamily = familyById(subscriptionToggleButton.dataset.familyId);
          if (!subscriptionFamily) return;
          var subscriptionAction = subscriptionToggleButton.dataset.subscriptionAction || (familySubscriptionActive(subscriptionFamily) ? "end" : "start");
          subscriptionToggleButton.disabled = true;
          try {
            var subscriptionResponse = await fetchJson("/api/admin/users/" + encodeURIComponent(familyRowId(subscriptionFamily)) + "/subscription-toggle", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: subscriptionAction })
            });
            await loadBackendState();
            writeDevOutput(subscriptionAction === "start" ? "Subscription started" : "Subscription ended", {
              mode: "backend",
              email: subscriptionResponse.family && subscriptionResponse.family.email,
              status: subscriptionResponse.family && subscriptionResponse.family.subscriptionStatus,
              stripeResult: subscriptionResponse.stripeResult || []
            });
            renderAdmin();
          } catch (error) {
            writeDevOutput("Subscription toggle failed", error);
          } finally {
            subscriptionToggleButton.disabled = false;
          }
          return;
        }

        var userActionButton = event.target.closest("[data-user-action]");
        if (userActionButton) {
          var userFamily = familyById(userActionButton.dataset.familyId);
          if (!userFamily) return;
          var userAction = userActionButton.dataset.userAction;
          var shouldLock = userAction === "toggle-lock" ? !familyLocked(userFamily) : userAction === "lock";
          userActionButton.disabled = true;
          try {
            var lockResponse = await fetchJson("/api/admin/users/" + encodeURIComponent(familyRowId(userFamily)) + "/lock", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locked: shouldLock })
            });
            await loadBackendState();
            writeDevOutput(shouldLock ? "Account locked" : "Account unlocked", {
              mode: "backend",
              email: lockResponse.email,
              status: lockResponse.accountLocked ? "locked" : "unlocked"
            });
            renderAdmin();
          } catch (error) {
            writeDevOutput("Account lock failed", error);
          } finally {
            userActionButton.disabled = false;
          }
          return;
        }

        var privacyActionButton = event.target.closest("[data-privacy-action]");
        if (privacyActionButton) {
          var privacyFamily = familyById(privacyActionButton.dataset.familyId);
          if (!privacyFamily) return;
          var privacyAction = privacyActionButton.dataset.privacyAction;
          if (privacyAction === "anonymize") {
            var ok = window.confirm("Anonymize this account now? This removes parent and student PII from KiddieGPT local data and cannot be undone.");
            if (!ok) return;
            privacyActionButton.disabled = true;
            var privacyState = document.getElementById("privacy-action-state");
            if (privacyState) {
              privacyState.textContent = "Working";
              privacyState.className = "state-chip warning";
            }
            try {
              var anonymizeResponse = await fetchJson("/api/admin/users/" + encodeURIComponent(familyRowId(privacyFamily)) + "/anonymize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
              });
              await loadBackendState();
              if (privacyState) {
                privacyState.textContent = "Anonymized";
                privacyState.className = "state-chip active";
              }
              writeDevOutput("Account anonymized", {
                familyId: anonymizeResponse.family && anonymizeResponse.family.id,
                deletedEmail: anonymizeResponse.deletedEmail || anonymizeResponse.family?.deletedEmail,
                nextDeletedEmail: nextDeletedEmailPreview()
              });
              renderAdmin();
            } catch (error) {
              if (privacyState) {
                privacyState.textContent = "Error";
                privacyState.className = "state-chip error";
              }
              writeDevOutput("Anonymize failed", error);
            } finally {
              privacyActionButton.disabled = false;
            }
          }
          return;
        }

        var familyButton = event.target.closest("[data-family-action]");
        if (familyButton) {
          var action = familyButton.dataset.familyAction;
          var family = familyById(familyButton.dataset.familyId);
          if (!family) return;
          familyButton.disabled = true;
          try {
            if (action === "email") {
              var emailPayload = await fetchJson("/api/admin/trigger-email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: family.email,
                  template: "Admin triggered parent email"
                })
              });
              writeDevOutput("Triggered parent email", emailPayload);
            } else {
              var subscriptionPayload = await fetchJson("/api/admin/subscription-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: action,
                  subscriptionId: stripeSubscriptionId(family),
                  email: family.email
                })
              });
              updateFamilyRecord(familyRowId(family), function (next) {
                next.subscriptionStatus = action === "pause" ? "paused" : "cancelled";
                next[action === "pause" ? "pausedAt" : "cancelledAt"] = new Date().toISOString();
              });
              writeDevOutput("Subscription " + action, subscriptionPayload);
              renderAdmin();
            }
          } catch (error) {
            writeDevOutput("Admin action failed", error);
          } finally {
            familyButton.disabled = false;
          }
          refreshDevStatus();
          return;
        }

        var refundButton = event.target.closest("[data-payment-action='refund']");
        if (!refundButton) return;
        var refundFamily = familyById(refundButton.dataset.familyId);
        if (!refundFamily) return;
        refundButton.disabled = true;
        try {
          var refundNoteBox = document.querySelector("[data-refund-note='" + familyRowId(refundFamily) + "']");
          var refundPayload = await fetchJson("/api/stripe/refund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentIntentId: refundButton.dataset.paymentId,
              amountCents: Number(refundButton.dataset.amountCents),
              email: refundFamily.email
            })
          });
          var refundEmailPayload = null;
          if (refundNoteBox && refundNoteBox.value.trim()) {
            try {
              refundEmailPayload = await fetchJson("/api/admin/trigger-email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: refundFamily.email,
                  template: "Refund note",
                  message: refundNoteBox.value.trim()
                })
              });
            } catch (emailError) {
              refundEmailPayload = { error: emailError.message || "Refund email failed" };
            }
          }
          await loadBackendState();
          writeDevOutput("Refund payment", { refund: refundPayload, email: refundEmailPayload || "not sent" });
          expandedPayment = null;
          renderAdmin();
        } catch (error) {
          writeDevOutput("Refund failed", error);
        } finally {
          refundButton.disabled = false;
        }
        refreshDevStatus();
      });
    }

    if (stripeTestForm && emailTestForm && loginTestForm) {
    stripeTestForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      try {
        var payload = await fetchJson("/api/stripe/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            priceId: stripeTestForm.elements.priceId.value.trim(),
            planName: "Admin test plan",
            parentEmail: stripeTestForm.elements.parentEmail.value.trim()
          })
        });
        writeDevOutput("Stripe checkout test", payload);
      } catch (error) {
        writeDevOutput("Stripe checkout failed", error);
      }
      refreshDevStatus();
    });

    if (bootstrapStripePrices) {
      bootstrapStripePrices.addEventListener("click", async function () {
        bootstrapStripePrices.disabled = true;
        writeDevOutput("Creating Stripe test prices", { message: "Creating monthly and yearly recurring prices in the current Stripe account." });
        try {
          var payload = await fetchJson("/api/dev/stripe/bootstrap-prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
          });
          pricingCache = payload.pricing || pricingCache;
          if (pricingCache) localStorage.setItem(PRICING_KEY, JSON.stringify(pricingCache));
          if (stripeTestForm && payload.monthlyPriceId) stripeTestForm.elements.priceId.value = payload.monthlyPriceId;
          syncPricingForm();
          await loadBackendState();
          renderAdmin();
          writeDevOutput("Stripe test prices created", payload);
        } catch (error) {
          writeDevOutput("Stripe price setup failed", error);
        } finally {
          bootstrapStripePrices.disabled = false;
        }
        refreshDevStatus();
      });
    }

    emailTestForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      try {
        var payload = await fetchJson("/api/dev/test-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: emailTestForm.elements.to.value.trim(),
            template: emailTestForm.elements.template.value
          })
        });
        writeDevOutput("Email test", payload);
      } catch (error) {
        writeDevOutput("Email test failed", error);
      }
      refreshDevStatus();
    });

    loginTestForm.addEventListener("change", function () {
      if (loginTestForm.elements.role.value === "admin") {
        loginTestForm.elements.email.value = "admin@kiddiegpt.demo";
        loginTestForm.elements.password.value = "admin123";
      } else {
        loginTestForm.elements.email.value = "parent.kiddiegpt@gmail.com";
        loginTestForm.elements.password.value = "kiddiegpt123";
      }
    });

    loginTestForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      try {
        var payload = await fetchJson("/api/dev/test-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: loginTestForm.elements.role.value,
            email: loginTestForm.elements.email.value.trim(),
            password: loginTestForm.elements.password.value
          })
        });
        writeDevOutput("Login test", payload);
      } catch (error) {
        writeDevOutput("Login test failed", error);
      }
      refreshDevStatus();
    });
    }

    setupAdminLoginGate().then(function () {
      loadBackendState().then(function () {
        // syncPricingForm() must not be gated on loadAiSettings(): if that
        // rejects, the pricing form keeps its blank HTML defaults, and the next
        // Save writes an unchecked promotion and $0 prices over real config.
        syncPricingForm();
        loadAiSettings().then(function () {
          renderAdmin();
        });
        loadAutopilotRules();
        loadSupportConversations();
      });
    });
  }

  setupParentPortal();
  setupAdminConsole();
  renderIcons();
})();

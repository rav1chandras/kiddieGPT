(function () {
  var STORAGE_KEY = "kiddiegptFamilies";
  var selectedFamilyId = null;

  function readFamilies() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (error) {
      return [];
    }
  }

  function writeFamilies(families) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(families));
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

  function renderIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function setupParentPortal() {
    var form = document.getElementById("onboarding-form");
    if (!form) return;

    var finish = document.getElementById("finish");
    var paymentButton = document.getElementById("mock-stripe");
    var paymentState = document.getElementById("payment-state");
    var cap = document.getElementById("usage-cap");
    var capLabel = document.getElementById("usage-cap-label");
    var completionPanel = document.getElementById("completion-panel");
    var completionTitle = document.getElementById("completion-title");
    var completionText = document.getElementById("completion-text");
    var childList = document.getElementById("child-list");
    var childTemplate = document.getElementById("child-template");
    var addChild = document.getElementById("add-child");
    var paid = false;

    function formValue(name) {
      return form.elements[name] ? form.elements[name].value : "";
    }

    function childProfiles() {
      return Array.from(document.querySelectorAll(".child-profile")).map(function (profile, index) {
        var name = profile.querySelector('[name="studentName"]').value.trim();
        var grade = profile.querySelector('[name="grade"]').value;
        var goal = profile.querySelector('[name="goal"]').value.trim();
        return {
          id: "child_" + (index + 1),
          studentName: name,
          grade: grade,
          goal: goal
        };
      }).filter(function (child) {
        return child.studentName || child.grade || child.goal;
      });
    }

    function updateChildCards() {
      var profiles = Array.from(document.querySelectorAll(".child-profile"));
      profiles.forEach(function (profile, index) {
        var nameInput = profile.querySelector('[name="studentName"]');
        var title = profile.querySelector("h3");
        var avatar = profile.querySelector(".avatar");
        var remove = profile.querySelector(".remove-child");
        var name = nameInput.value.trim();
        title.textContent = name || "Child " + (index + 1);
        avatar.textContent = (name || "C").charAt(0).toUpperCase();
        profile.dataset.childIndex = String(index);
        remove.classList.toggle("hidden", profiles.length === 1);
      });
    }

    function preview() {
      var capValue = formValue("usageCap") || "60";
      var children = childProfiles();
      document.getElementById("preview-cap").textContent = capValue + " min";
      document.getElementById("preview-children").textContent = children.length + (children.length === 1 ? " profile" : " profiles");
      document.getElementById("preview-subscription").textContent = paid ? "Active" : "Pending";
      document.getElementById("preview-access").textContent = paid && children.length ? "Unlocked" : "Locked";
      capLabel.textContent = capValue + " min";
      updateChildCards();
    }

    function validateForm() {
      var fields = Array.from(form.querySelectorAll("input, select"));
      for (var i = 0; i < fields.length; i += 1) {
        if (!fields[i].checkValidity()) {
          fields[i].reportValidity();
          return false;
        }
      }
      if (!paid) {
        paymentState.textContent = "Complete simulated Stripe payment before activating";
        paymentState.className = "state-chip error";
        return false;
      }
      if (!childProfiles().length) {
        completionTitle.textContent = "Add a child profile";
        completionText.textContent = "At least one child profile is needed before the extension can unlock tools.";
        return false;
      }
      return true;
    }

    paymentButton.addEventListener("click", function () {
      paid = true;
      paymentState.textContent = "Subscription active";
      paymentState.className = "state-chip ok";
      completionTitle.textContent = "Ready to activate";
      completionText.textContent = "Payment is active. Review child profiles and guardrails, then activate the family account.";
      preview();
    });

    addChild.addEventListener("click", function () {
      var count = document.querySelectorAll(".child-profile").length;
      if (count >= 3) {
        completionTitle.textContent = "Family plan limit";
        completionText.textContent = "The demo family plan includes up to 3 child profiles.";
        return;
      }
      var clone = childTemplate.content.firstElementChild.cloneNode(true);
      clone.querySelector("h3").textContent = "Child " + (count + 1);
      childList.appendChild(clone);
      updateChildCards();
      renderIcons();
    });

    childList.addEventListener("click", function (event) {
      var remove = event.target.closest(".remove-child");
      if (!remove) return;
      var profile = remove.closest(".child-profile");
      if (document.querySelectorAll(".child-profile").length > 1) {
        profile.remove();
        preview();
      }
    });

    childList.addEventListener("input", function () {
      preview();
    });

    childList.addEventListener("change", function () {
      preview();
    });

    form.addEventListener("input", function (event) {
      if (event.target.closest("#child-list")) {
        return;
      }
      preview();
    });

    form.addEventListener("change", function () {
      preview();
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!validateForm()) return;

      var data = new FormData(form);
      var children = childProfiles();
      var primaryChild = children[0];
      var family = {
        id: makeId(),
        parentName: text(data.get("parentName")),
        email: text(data.get("email")),
        studentName: text(primaryChild.studentName),
        grade: text(primaryChild.grade),
        goal: text(primaryChild.goal),
        children: children.map(function (child, index) {
          return {
            id: "child_" + makeId() + "_" + index,
            studentName: text(child.studentName),
            grade: text(child.grade),
            goal: text(child.goal)
          };
        }),
        plan: moneyPlan(),
        subscriptionStatus: paid ? "active" : "pending",
        guardrails: {
          showSteps: data.get("showSteps") === "on",
          blockDirectAnswers: data.get("blockDirectAnswers") === "on",
          weeklySummary: data.get("weeklySummary") === "on",
          usageCap: Number(data.get("usageCap")) || 60
        },
        createdAt: new Date().toISOString()
      };

      var families = readFamilies();
      families.unshift(family);
      writeFamilies(families);

      completionTitle.textContent = "Family is active";
      completionText.textContent =
        family.children.length + " child " +
        (family.children.length === 1 ? "profile is" : "profiles are") +
        " ready. Extension access is unlocked for this demo.";
      completionPanel.classList.add("is-active");
      renderIcons();
    });

    cap.addEventListener("input", preview);
    updateChildCards();
    preview();
    renderIcons();
  }

  function seedFamilies() {
    var existing = readFamilies();
    var demo = [
      {
        id: makeId(),
        parentName: "Ravi Parent",
        email: "parent@kiddiegpt.test",
        studentName: "Ava",
        grade: "Grade 5",
        goal: "Build confidence in math word problems",
        children: [
          { id: "child_demo_1", studentName: "Ava", grade: "Grade 5", goal: "Build confidence in math word problems" },
          { id: "child_demo_2", studentName: "Milo", grade: "Grade 3", goal: "Practice reading fluency" }
        ],
        plan: moneyPlan(),
        subscriptionStatus: "active",
        guardrails: { showSteps: true, blockDirectAnswers: true, weeklySummary: true, usageCap: 60 },
        createdAt: new Date().toISOString()
      },
      {
        id: makeId(),
        parentName: "Maya Singh",
        email: "maya@example.com",
        studentName: "Nikhil",
        grade: "Grade 7",
        goal: "Better reading comprehension and study habits",
        children: [
          { id: "child_demo_3", studentName: "Nikhil", grade: "Grade 7", goal: "Better reading comprehension and study habits" }
        ],
        plan: moneyPlan(),
        subscriptionStatus: "pending",
        guardrails: { showSteps: true, blockDirectAnswers: true, weeklySummary: false, usageCap: 45 },
        createdAt: new Date(Date.now() - 86400000 * 2).toISOString()
      }
    ];
    writeFamilies(demo.concat(existing));
  }

  function setupAdminConsole() {
    var table = document.getElementById("family-table");
    if (!table) return;

    var search = document.getElementById("family-search");
    var statusFilter = document.getElementById("status-filter");
    var seedButton = document.getElementById("seed-data");

    function filteredFamilies() {
      var query = search.value.trim().toLowerCase();
      var status = statusFilter.value;
      return readFamilies().filter(function (family) {
        var haystack = [family.parentName, family.email, family.studentName, family.grade, family.goal].join(" ").toLowerCase();
        var matchesQuery = !query || haystack.indexOf(query) >= 0;
        var matchesStatus = status === "all" || family.subscriptionStatus === status;
        return matchesQuery && matchesStatus;
      });
    }

    function setMetric(id, value) {
      document.getElementById(id).textContent = String(value);
    }

    function selectFamily(family) {
      selectedFamilyId = family ? family.id : null;
      document.getElementById("detail-name").textContent = family ? family.parentName : "No family selected";
      document.getElementById("detail-status").textContent = family ? family.subscriptionStatus : "Waiting";
      document.getElementById("detail-status").className = "state-chip " + (family ? family.subscriptionStatus : "");
      document.getElementById("detail-email").textContent = family ? family.email : "-";
      document.getElementById("detail-student").textContent = family ? family.studentName : "-";
      document.getElementById("detail-grade").textContent = family ? family.grade : "-";
      document.getElementById("detail-cap").textContent = family ? family.guardrails.usageCap + " min" : "-";
      document.getElementById("detail-goal").textContent = family ? text(family.goal) : "-";
    }

    function renderAdmin() {
      var families = readFamilies();
      var visible = filteredFamilies();
      var active = families.filter(function (family) { return family.subscriptionStatus === "active"; });
      var summaries = families.filter(function (family) { return family.guardrails && family.guardrails.weeklySummary; });
      var studentTotal = families.reduce(function (total, family) {
        return total + (family.children ? family.children.length : 1);
      }, 0);

      setMetric("total-families", families.length);
      setMetric("active-subs", active.length);
      setMetric("student-count", studentTotal);
      setMetric("weekly-summary-count", summaries.length);

      table.innerHTML = "";

      visible.forEach(function (family) {
        var row = document.createElement("tr");
        row.tabIndex = 0;
        row.className = family.id === selectedFamilyId ? "selected" : "";
        row.innerHTML =
          "<td><strong>" + text(family.parentName) + "</strong></td>" +
          "<td>" + text(family.email) + "</td>" +
          "<td>" + text(family.studentName) + "<small>" + text(family.grade) + (family.children && family.children.length > 1 ? " +" + (family.children.length - 1) + " more" : "") + "</small></td>" +
          "<td>" + text(family.plan || moneyPlan()) + "</td>" +
          "<td><span class='state-chip " + text(family.subscriptionStatus) + "'>" + text(family.subscriptionStatus) + "</span></td>" +
          "<td>" + (family.guardrails && family.guardrails.blockDirectAnswers ? "Coaching" : "Open") + "</td>" +
          "<td>" + new Date(family.createdAt).toLocaleDateString() + "</td>";
        row.addEventListener("click", function () {
          selectFamily(family);
          renderAdmin();
        });
        table.appendChild(row);
      });

      if (!selectedFamilyId && families.length) {
        selectFamily(families[0]);
      }

      renderIcons();
    }

    search.addEventListener("input", renderAdmin);
    statusFilter.addEventListener("change", renderAdmin);
    seedButton.addEventListener("click", function () {
      seedFamilies();
      selectedFamilyId = null;
      renderAdmin();
    });

    renderAdmin();
  }

  setupParentPortal();
  setupAdminConsole();
  renderIcons();
})();

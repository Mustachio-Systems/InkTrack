// ============================================================
// INKTRACK — App Logic v3
// Talks to the InkTrack Worker API. No business data touches
// localStorage anymore — only a non-secret "last known name"
// for instant UI paint while /api/me confirms the real session.
// ============================================================

// ---- SET THIS to your deployed Worker URL ----
const API_BASE = window.INKTRACK_API_BASE || "https://inktrack-api.YOUR-SUBDOMAIN.workers.dev";

document.addEventListener("DOMContentLoaded", () => {

  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: "include", // send the HttpOnly session cookie
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const message = (body && body.error) || "Something went wrong. Try again.";
      const e = new Error(message);
      e.status = res.status;
      throw e;
    }
    return body;
  }

  function showFormError(el, message) {
    el.textContent = message;
    el.classList.remove("hidden");
  }

  // ---------- SIGN UP ----------
  const signupForm = document.getElementById("signup-form");
  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("signup-error");
      errorEl.classList.add("hidden");
      const submitBtn = signupForm.querySelector('button[type="submit"]');

      const name = document.getElementById("artist-name").value.trim();
      const email = document.getElementById("email").value.trim().toLowerCase();
      const password = document.getElementById("password").value;

      if (!name || !email || password.length < 8) {
        showFormError(errorEl, "Fill in your name, email, and a password of at least 8 characters.");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Creating Profile…";
      try {
        await api("/api/signup", { method: "POST", body: JSON.stringify({ name, email, password }) });
        window.location.href = "dashboard.html";
      } catch (err) {
        showFormError(errorEl, err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Profile";
      }
    });
  }

  // ---------- LOG IN ----------
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("login-error");
      errorEl.classList.add("hidden");
      const submitBtn = loginForm.querySelector('button[type="submit"]');

      const email = document.getElementById("email").value.trim().toLowerCase();
      const password = document.getElementById("password").value;

      submitBtn.disabled = true;
      submitBtn.textContent = "Checking…";
      try {
        await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
        window.location.href = "dashboard.html";
      } catch (err) {
        showFormError(errorEl, err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = "Log In";
      }
    });
  }

  // ---------- DASHBOARD ----------
  const onDashboardPage = /\/dashboard(\.html)?\/?$/.test(window.location.pathname);
  if (onDashboardPage) {
    initDashboard();
  }

  async function initDashboard() {
    let me;
    try {
      me = await api("/api/me");
    } catch {
      window.location.href = "login.html";
      return;
    }

    const artistName = me.artist.name;
    const topArtistHeader = document.getElementById("top-artist-name");
    if (topArtistHeader) topArtistHeader.innerText = artistName;

    const TATTOO_STYLES = ["Traditional", "Neo-Traditional", "Realism", "Fine Line", "Blackwork", "Japanese", "Tribal", "Watercolor"];
    let selectedStyle = null;
    let editingId = null;
    let cachedEntries = [];

    const trackerForm = document.getElementById("tracker-form");
    const dateInput = document.getElementById("entry-date");
    const clientInput = document.getElementById("client-name");
    const weeklyLogsTbody = document.getElementById("weekly-logs-tbody");
    const emptyState = document.getElementById("empty-state");
    const tableWrapper = document.getElementById("table-wrapper");
    const formActionTitle = document.getElementById("form-action-title");
    const formSubmitBtn = document.getElementById("form-submit-btn");
    const formCancelBtn = document.getElementById("form-cancel-btn");
    const formError = document.getElementById("form-error");

    const analyticsModal = document.getElementById("analytics-modal");
    const closeModalBtn = document.getElementById("close-modal-btn");
    const modalWeekTitle = document.getElementById("modal-week-title");
    const modalDailyContainer = document.getElementById("modal-daily-container");
    const deleteWeekBtn = document.getElementById("delete-week-btn");

    const menuToggle = document.getElementById("menu-toggle");
    const sidebar = document.getElementById("sidebar");
    const logoutBtn = document.getElementById("logout-btn");
    const exportBtn = document.getElementById("export-btn");
    const importBtn = document.getElementById("import-btn");
    const importFileInput = document.getElementById("import-file-input");

    let activeTargetWeekStart = null;

    const SUBMIT_DEFAULT_CLASS = "flex-1 font-mono text-xs uppercase tracking-widest bg-[var(--ink-red)] text-[var(--paper)] py-3.5 rounded hover:bg-[var(--ink-red-dim)] transition active:scale-[0.98]";
    const SUBMIT_EDIT_CLASS = "flex-1 font-mono text-xs uppercase tracking-widest bg-[var(--ink-teal-bright)] text-[var(--skin)] py-3.5 rounded hover:opacity-90 transition active:scale-[0.98]";

    // ---- Mobile nav ----
    if (menuToggle) {
      menuToggle.addEventListener("click", () => {
        const isHidden = sidebar.classList.contains("hidden");
        sidebar.classList.toggle("hidden");
        menuToggle.setAttribute("aria-expanded", String(isHidden));
      });
    }

    // ---- Logout ----
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        try { await api("/api/logout", { method: "POST" }); } catch { /* ignore */ }
        window.location.href = "index.html";
      });
    }

    // ---- Export backup ----
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        try {
          const payload = await api("/api/export");
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `inktrack-backup-${new Date().toISOString().split("T")[0]}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(`Couldn't export your backup: ${err.message}`);
        }
      });
    }

    // ---- Import backup ----
    if (importBtn && importFileInput) {
      importBtn.addEventListener("click", () => importFileInput.click());
      importFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
          try {
            const parsed = JSON.parse(evt.target.result);
            if (!Array.isArray(parsed.entries)) throw new Error("Malformed backup file.");
            const proceed = confirm(`Import ${parsed.entries.length} entries? This adds to your current data.`);
            if (!proceed) return;

            const result = await api("/api/import", { method: "POST", body: JSON.stringify({ entries: parsed.entries }) });
            await refreshEntries();
            alert(`Imported ${result.imported} session${result.imported === 1 ? "" : "s"}.`);
          } catch (err) {
            alert(`Couldn't import that file: ${err.message}`);
          }
        };
        reader.readAsText(file);
        importFileInput.value = "";
      });
    }

    // ---- Date default ----
    function setDefaultDate() {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      dateInput.value = `${yyyy}-${mm}-${dd}`;
    }
    setDefaultDate();

    // ---- Style pill picker ----
    const stylePickerEl = document.getElementById("style-picker");
    function renderStylePicker() {
      if (!stylePickerEl) return;
      stylePickerEl.innerHTML = TATTOO_STYLES.map(style => `
                <button type="button" data-style="${style}"
                    class="style-pill ${selectedStyle === style ? 'active' : ''} font-mono text-[11px] uppercase tracking-wide px-3 py-2 rounded">
                    ${style}
                </button>
            `).join("");
    }
    renderStylePicker();
    if (stylePickerEl) {
      stylePickerEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-style]");
        if (!btn) return;
        const style = btn.getAttribute("data-style");
        selectedStyle = (selectedStyle === style) ? null : style;
        renderStylePicker();
      });
    }

    // ---- ISO week (Monday start) ----
    function getMondayISOString(dateString) {
      const date = new Date(dateString + "T00:00:00");
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date.setDate(diff));
      return monday.toISOString().split("T")[0];
    }

    async function refreshEntries() {
      try {
        const data = await api("/api/entries");
        cachedEntries = data.entries;
      } catch (err) {
        if (err.status === 401) { window.location.href = "login.html"; return; }
        cachedEntries = [];
      }
      renderWeeklyHistory();
      recalculateHistoricalBaseline();
    }

    // ---- Trend metrics ----
    function computeTrendMetrics() {
      const entries = cachedEntries;

      let cumulativeNet = 0;
      const weekdayNet = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
      const weekdayHours = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const styleNet = {};
      const styleHours = {};

      entries.forEach(entry => {
        const net = entry.grossGains - (entry.supplySpend || 0);
        cumulativeNet += net;
        const dayIndex = new Date(entry.date + "T00:00:00").getDay();
        weekdayNet[dayIndex] += net;
        weekdayHours[dayIndex] += entry.hoursWorked;

        if (entry.style) {
          styleNet[entry.style] = (styleNet[entry.style] || 0) + net;
          styleHours[entry.style] = (styleHours[entry.style] || 0) + entry.hoursWorked;
        }
      });

      const lifetimeNetEl = document.getElementById("trend-lifetime-net");
      if (lifetimeNetEl) lifetimeNetEl.innerText = `$${cumulativeNet.toFixed(2)}`;

      let highestRate = 0;
      let peakDayName = "No records yet";
      for (let i = 0; i < 7; i++) {
        if (weekdayHours[i] > 0) {
          const rate = weekdayNet[i] / weekdayHours[i];
          if (rate > highestRate) {
            highestRate = rate;
            peakDayName = `${dayNames[i]} ($${rate.toFixed(2)}/hr)`;
          }
        }
      }
      const peakDayEl = document.getElementById("trend-peak-day");
      if (peakDayEl) peakDayEl.innerText = peakDayName;

      let bestStyleRate = 0;
      let bestStyleName = "Tag sessions to see";
      Object.keys(styleHours).forEach(style => {
        if (styleHours[style] > 0) {
          const rate = styleNet[style] / styleHours[style];
          if (rate > bestStyleRate) {
            bestStyleRate = rate;
            bestStyleName = `${style} ($${rate.toFixed(2)}/hr)`;
          }
        }
      });
      const bestStyleEl = document.getElementById("trend-best-style");
      if (bestStyleEl) bestStyleEl.innerText = bestStyleName;

      const todayStr = new Date().toISOString().split("T")[0];
      const activeMonStr = getMondayISOString(todayStr);
      let activeWeekTotal = 0;
      entries.forEach(entry => {
        if (getMondayISOString(entry.date) === activeMonStr) {
          activeWeekTotal += (entry.grossGains - (entry.supplySpend || 0));
        }
      });

      const weeklyTotalEl = document.getElementById("trend-weekly-total");
      if (weeklyTotalEl) weeklyTotalEl.innerText = `$${activeWeekTotal.toFixed(2)}`;

      const badgeEl = document.getElementById("trend-weekly-badge");
      if (badgeEl) {
        if (activeWeekTotal > 1500) {
          badgeEl.className = "font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-[var(--ink-teal-bright)]/40 text-[var(--ink-teal-bright)] uppercase tracking-wider";
          badgeEl.innerText = "High Yield";
        } else if (activeWeekTotal > 0) {
          badgeEl.className = "font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-[var(--ink-red)]/40 text-[var(--ink-red-bright)] uppercase tracking-wider";
          badgeEl.innerText = "Pacing Normal";
        } else {
          badgeEl.className = "font-mono text-[10px] font-bold px-2 py-0.5 rounded border border-[var(--line-bright)] text-[var(--pencil)] uppercase tracking-wider";
          badgeEl.innerText = "No Hours Yet";
        }
      }
    }

    // ---- Edit / Delete session ----
    window.triggerEditDay = function (entryId) {
      const match = cachedEntries.find(e => e.id === entryId);
      if (!match) return;

      analyticsModal.classList.add("hidden");

      editingId = entryId;
      dateInput.value = match.date;
      clientInput.value = match.clientName || "";
      document.getElementById("daily-gains").value = match.grossGains;
      document.getElementById("daily-hours").value = match.hoursWorked;
      document.getElementById("supply-spend").value = match.supplySpend || "";
      selectedStyle = match.style || null;
      renderStylePicker();

      formActionTitle.innerText = "MODIFY SESSION";
      formSubmitBtn.innerText = "Save Changes";
      formSubmitBtn.className = SUBMIT_EDIT_CLASS;
      formCancelBtn.classList.remove("hidden");

      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    window.triggerDeleteDay = async function (entryId) {
      if (!confirm(`Delete this session? This can't be undone.`)) return;
      try {
        await api(`/api/entries/${entryId}`, { method: "DELETE" });
        await refreshEntries();
        if (activeTargetWeekStart) openWeeklyAuditModal(activeTargetWeekStart);
      } catch (err) {
        alert(`Couldn't delete that session: ${err.message}`);
      }
    };

    // ---- Cancel edit ----
    if (formCancelBtn) {
      formCancelBtn.addEventListener("click", () => resetForm());
    }

    function resetForm() {
      editingId = null;
      setDefaultDate();
      clientInput.value = "";
      selectedStyle = null;
      renderStylePicker();
      formActionTitle.innerText = "LOG NEW SESSION";
      formSubmitBtn.innerText = "Save Session";
      formSubmitBtn.className = SUBMIT_DEFAULT_CLASS;
      formCancelBtn.classList.add("hidden");
      formError.classList.add("hidden");
      document.getElementById("daily-gains").value = "";
      document.getElementById("daily-hours").value = "";
      document.getElementById("supply-spend").value = "";
    }

    // ---- Delete whole week ----
    if (deleteWeekBtn) {
      deleteWeekBtn.addEventListener("click", async () => {
        if (!activeTargetWeekStart) return;
        if (!confirm(`Delete every logged session in the week starting ${activeTargetWeekStart}? This can't be undone.`)) return;

        const toDelete = cachedEntries.filter(entry => getMondayISOString(entry.date) === activeTargetWeekStart);
        try {
          await Promise.all(toDelete.map(entry => api(`/api/entries/${entry.id}`, { method: "DELETE" })));
          analyticsModal.classList.add("hidden");
          await refreshEntries();
        } catch (err) {
          alert(`Couldn't delete the full week: ${err.message}`);
          await refreshEntries();
        }
      });
    }

    // ---- Audit modal (Grouped by Day with multiple sessions) ----
    function openWeeklyAuditModal(weekStart) {
      if (!analyticsModal || !modalDailyContainer) return;

      activeTargetWeekStart = weekStart;
      const entries = cachedEntries;

      const monDate = new Date(weekStart + "T00:00:00");
      const sunDate = new Date(monDate);
      sunDate.setDate(monDate.getDate() + 6);

      modalWeekTitle.innerText = `${weekStart} → ${sunDate.toISOString().split("T")[0]}`;
      modalDailyContainer.innerHTML = "";

      const todayObj = new Date();
      todayObj.setHours(0, 0, 0, 0);

      const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

      for (let i = 0; i < 7; i++) {
        const currentDayObj = new Date(monDate);
        currentDayObj.setDate(monDate.getDate() + i);
        const currentDayStr = currentDayObj.toISOString().split("T")[0];
        const dayLabel = dayNames[i];

        const daySessions = entries.filter(e => e.date === currentDayStr);

        const dayWrapper = document.createElement("div");
        dayWrapper.className = "pb-4 border-b border-[var(--line)] last:border-b-0";

        const dayHeader = document.createElement("div");
        dayHeader.className = "flex justify-between items-center mb-3 flex-wrap gap-2";

        let totalDayNet = daySessions.reduce((sum, e) => sum + (e.grossGains - (e.supplySpend || 0)), 0);
        let totalDayHours = daySessions.reduce((sum, e) => sum + e.hoursWorked, 0);

        if (daySessions.length > 0) {
          dayHeader.innerHTML = `
                        <div>
                            <span class="font-display text-lg text-[var(--paper)]">${dayLabel}</span>
                            <span class="font-mono text-[10px] text-[var(--pencil-dim)] ml-2 uppercase tracking-widest">${currentDayStr} • ${daySessions.length} Session${daySessions.length > 1 ? 's' : ''}</span>
                        </div>
                        <div class="text-right font-mono text-xs">
                            <span class="text-[var(--ink-teal-bright)] font-bold">$${totalDayNet.toFixed(2)}</span> Net<br>
                            <span class="text-[var(--pencil-dim)]">${totalDayHours.toFixed(1)} hrs • $${(totalDayHours > 0 ? totalDayNet / totalDayHours : 0).toFixed(2)}/hr</span>
                        </div>
                    `;
          dayWrapper.appendChild(dayHeader);

          const sessionList = document.createElement("div");
          sessionList.className = "space-y-2 pl-3 sm:pl-4 border-l-2 border-[var(--line-bright)]";

          daySessions.forEach(data => {
            const netProfit = data.grossGains - (data.supplySpend || 0);
            const hourlyRate = data.hoursWorked > 0 ? (netProfit / data.hoursWorked) : 0;
            const styleLabel = data.style
              ? `<span class="text-[10px] uppercase tracking-wide border border-[var(--ink-gold)]/40 text-[var(--ink-gold)] px-1.5 py-0.5 rounded">${escapeHtml(data.style)}</span>`
              : `<span class="text-[10px] text-[var(--pencil-dim)]">No Style</span>`;

            const clientLabel = data.clientName
              ? `<span class="text-[var(--paper)] font-bold text-sm">${escapeHtml(data.clientName)}</span>`
              : `<span class="text-[var(--pencil-dim)] text-sm italic">Unknown Client</span>`;

            const sessionEl = document.createElement("div");
            sessionEl.className = "session-row";
            sessionEl.innerHTML = `
                            <div class="flex-1 min-w-[150px]">
                                <div class="flex items-center gap-2 mb-1 flex-wrap">${clientLabel} ${styleLabel}</div>
                                <div class="font-mono text-[10px] text-[var(--pencil-dim)] flex gap-3 flex-wrap">
                                    <span>Gross: $${data.grossGains.toFixed(2)}</span>
                                    ${data.supplySpend > 0 ? `<span>Supplies: -$${data.supplySpend.toFixed(2)}</span>` : ''}
                                    <span>Time: ${data.hoursWorked.toFixed(1)}h</span>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="font-display text-xl text-[var(--paper)]">$${hourlyRate.toFixed(2)}<span class="text-[10px] text-[var(--pencil)] font-mono">/hr</span></div>
                            </div>
                            <div class="flex gap-1.5 w-full sm:w-auto justify-end">
                                <button data-edit="${data.id}" class="text-[11px] border border-[var(--line-bright)] hover:border-[var(--ink-teal-bright)] hover:text-[var(--ink-teal-bright)] px-2.5 py-1.5 rounded transition">Edit</button>
                                <button data-delete="${data.id}" class="text-[11px] border border-[var(--ink-red)]/30 text-[var(--ink-red)] hover:bg-[var(--ink-red)] hover:text-[var(--paper)] px-2.5 py-1.5 rounded transition">Delete</button>
                            </div>
                        `;
            sessionList.appendChild(sessionEl);
          });

          dayWrapper.appendChild(sessionList);
        } else if (currentDayObj > todayObj) {
          dayHeader.innerHTML = `
                        <div>
                            <span class="font-display text-lg text-[var(--pencil-dim)]">${dayLabel}</span>
                            <span class="font-mono text-[10px] text-[var(--pencil-dim)] ml-2 uppercase tracking-widest">${currentDayStr}</span>
                        </div>
                        <span class="font-mono text-[10px] uppercase text-[var(--ink-teal-bright)]/60 tracking-wider">Upcoming</span>
                    `;
          dayWrapper.appendChild(dayHeader);
        } else {
          dayHeader.innerHTML = `
                        <div>
                            <span class="font-display text-lg text-[var(--pencil)]">${dayLabel}</span>
                            <span class="font-mono text-[10px] text-[var(--pencil-dim)] ml-2 uppercase tracking-widest">${currentDayStr}</span>
                        </div>
                        <button data-log="${currentDayStr}" class="text-[11px] border border-[var(--line-bright)] text-[var(--pencil)] hover:text-[var(--paper)] hover:border-[var(--paper)] px-2.5 py-1.5 rounded transition font-mono uppercase">+ Log Session</button>
                    `;
          dayWrapper.appendChild(dayHeader);
        }

        modalDailyContainer.appendChild(dayWrapper);
      }

      analyticsModal.classList.remove("hidden");
    }

    function escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    // Event delegation for modal actions
    modalDailyContainer.addEventListener("click", (e) => {
      const editId = e.target.getAttribute("data-edit");
      const deleteId = e.target.getAttribute("data-delete");
      const logDate = e.target.getAttribute("data-log");
      if (editId) window.triggerEditDay(editId);
      if (deleteId) window.triggerDeleteDay(deleteId);
      if (logDate) {
        resetForm();
        dateInput.value = logDate;
        analyticsModal.classList.add("hidden");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });

    if (closeModalBtn) closeModalBtn.addEventListener("click", () => analyticsModal.classList.add("hidden"));
    if (analyticsModal) {
      analyticsModal.addEventListener("click", (e) => {
        if (e.target === analyticsModal) analyticsModal.classList.add("hidden");
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !analyticsModal.classList.contains("hidden")) {
          analyticsModal.classList.add("hidden");
        }
      });
    }

    // ---- Weekly history table ----
    function renderWeeklyHistory() {
      computeTrendMetrics();
      const entries = cachedEntries;

      if (entries.length === 0) {
        emptyState.classList.remove("hidden");
        tableWrapper.classList.add("hidden");
        weeklyLogsTbody.innerHTML = "";
        return;
      }
      emptyState.classList.add("hidden");
      tableWrapper.classList.remove("hidden");
      weeklyLogsTbody.innerHTML = "";

      const uniqueWeeks = new Set();
      entries.forEach(entry => uniqueWeeks.add(getMondayISOString(entry.date)));

      const todayStr = new Date().toISOString().split("T")[0];
      uniqueWeeks.add(getMondayISOString(todayStr));

      const todayObj = new Date();
      todayObj.setHours(0, 0, 0, 0);

      Array.from(uniqueWeeks).sort().reverse().forEach(weekStart => {
        let totalGains = 0;
        let totalHours = 0;
        let sessionCount = 0;
        let futureDaysCount = 0;

        const monDate = new Date(weekStart + "T00:00:00");

        for (let i = 0; i < 7; i++) {
          const currentDayObj = new Date(monDate);
          currentDayObj.setDate(monDate.getDate() + i);
          const currentDayStr = currentDayObj.toISOString().split("T")[0];

          const dayEntries = entries.filter(e => e.date === currentDayStr);
          if (dayEntries.length > 0) {
            dayEntries.forEach(entry => {
              totalGains += (entry.grossGains - (entry.supplySpend || 0));
              totalHours += entry.hoursWorked;
              sessionCount++;
            });
          } else if (currentDayObj > todayObj) {
            futureDaysCount += 1;
          }
        }

        const hourlyAvg = totalHours > 0 ? (totalGains / totalHours) : 0;
        const sunDate = new Date(monDate);
        sunDate.setDate(monDate.getDate() + 6);
        const weekRangeStr = `${weekStart} → ${sunDate.toISOString().split("T")[0]}`;

        const statusBadge = futureDaysCount > 0
          ? `<span class="font-mono text-[10px] uppercase tracking-wider border border-[var(--ink-red)]/30 text-[var(--ink-red)] px-2 py-1 rounded">In Progress</span>`
          : `<span class="font-mono text-[10px] uppercase tracking-wider border border-[var(--ink-teal-bright)]/30 text-[var(--ink-teal-bright)] px-2 py-1 rounded">Finalized</span>`;

        const row = document.createElement("tr");
        row.className = "hover:bg-white/[0.03] transition cursor-pointer select-none group";
        row.title = "Tap to view daily breakdown";

        row.innerHTML = `
                    <td data-label="Week" class="py-3 px-3 font-mono text-[var(--pencil)] group-hover:text-[var(--ink-red)] transition">${weekRangeStr}</td>
                    <td data-label="Net Income" class="py-3 px-3 font-display text-lg">$${totalGains.toFixed(2)}</td>
                    <td data-label="Hours" class="py-3 px-3 font-mono text-[var(--pencil)]">${totalHours.toFixed(1)} hrs</td>
                    <td data-label="Avg $/hr" class="py-3 px-3 font-mono text-[var(--ink-teal-bright)]">$${hourlyAvg.toFixed(2)}/hr</td>
                    <td data-label="Sessions" class="py-3 px-3 font-mono text-[var(--paper)]">${sessionCount}</td>
                    <td data-label="Status" class="py-3 px-3">${statusBadge}</td>
                `;

        row.addEventListener("click", () => openWeeklyAuditModal(weekStart));
        weeklyLogsTbody.appendChild(row);
      });
    }

    // ---- Top stats + projections (All-time Average) ----
    function recalculateHistoricalBaseline() {
      const entries = cachedEntries;

      if (entries.length === 0) {
        document.getElementById("stat-hourly").innerHTML = `$0.00<span class="text-base text-[var(--pencil)] font-mono"> /hr</span>`;
        document.getElementById("stat-second").innerHTML = `$0.0000<span class="text-base text-[var(--pencil)] font-mono"> /sec</span>`;
        document.getElementById("proj-halfmonth").innerText = "$0.00";
        document.getElementById("proj-monthly").innerText = "$0.00";
        document.getElementById("proj-3month").innerText = "$0.00";
        document.getElementById("proj-1year").innerText = "$0.00";
        return;
      }

      let totalNet = 0;
      let totalHours = 0;

      entries.forEach(entry => {
        totalNet += (entry.grossGains - (entry.supplySpend || 0));
        totalHours += entry.hoursWorked;
      });

      const avgHourlyRate = totalHours > 0 ? (totalNet / totalHours) : 0;
      const perSecondRate = avgHourlyRate / 3600;

      document.getElementById("stat-hourly").innerHTML = `$${avgHourlyRate.toFixed(2)}<span class="text-base text-[var(--pencil)] font-mono"> /hr</span>`;
      document.getElementById("stat-second").innerHTML = `$${perSecondRate.toFixed(4)}<span class="text-base text-[var(--pencil)] font-mono"> /sec</span>`;

      const avgDailyNet = avgHourlyRate * 8;

      document.getElementById("proj-halfmonth").innerText = `$${(avgDailyNet * 15.22).toFixed(2)}`;
      document.getElementById("proj-monthly").innerText = `$${(avgDailyNet * 30.44).toFixed(2)}`;
      document.getElementById("proj-3month").innerText = `$${(avgDailyNet * 91.31).toFixed(2)}`;
      document.getElementById("proj-1year").innerText = `$${(avgDailyNet * 365.25).toFixed(2)}`;
    }

    // ---- Submit entry ----
    trackerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.classList.add("hidden");

      const selectedDate = dateInput.value;
      const clientName = clientInput.value.trim();
      const grossGains = parseFloat(document.getElementById("daily-gains").value);
      const hoursWorked = parseFloat(document.getElementById("daily-hours").value);
      const supplySpend = parseFloat(document.getElementById("supply-spend").value) || 0;

      if (!selectedDate || isNaN(grossGains) || grossGains < 0) {
        showFormError(formError, "Enter a valid date and a gross amount of $0 or more.");
        return;
      }
      if (isNaN(hoursWorked) || hoursWorked <= 0) {
        showFormError(formError, "Hours worked must be greater than 0.");
        return;
      }

      const payload = { date: selectedDate, clientName, grossGains, hoursWorked, supplySpend, style: selectedStyle };

      formSubmitBtn.disabled = true;
      const originalLabel = formSubmitBtn.innerText;
      formSubmitBtn.innerText = "Saving…";

      try {
        if (editingId) {
          await api(`/api/entries/${editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        } else {
          await api("/api/entries", { method: "POST", body: JSON.stringify(payload) });
        }
        resetForm();
        await refreshEntries();
      } catch (err) {
        showFormError(formError, err.message);
        formSubmitBtn.disabled = false;
        formSubmitBtn.innerText = originalLabel;
      }
    });

    // ---- Initial render ----
    await refreshEntries();
  }
});

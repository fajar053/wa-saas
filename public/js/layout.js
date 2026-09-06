// public/js/layout.js - Master Layout Engine (Responsive Desktop & Mobile Engine with WA Connected Indicator)

(function() {
  let socketInstance = null;

  document.addEventListener("DOMContentLoaded", () => {
    const token = localStorage.getItem("token");
    if (!token && !window.location.pathname.includes("login.html") && !window.location.pathname.includes("index.html")) {
      window.location.href = "/login.html";
      return;
    }

    // 1. Inject Sidebar, Topbar & Mobile Drawer
    injectLayout();

    // 2. Render Ikon Lucide
    if (typeof lucide !== "undefined") lucide.createIcons();

    // 3. Muat Profil & Inisialisasi Socket Realtime Status WA
    if (token) {
      loadGlobalUserProfile(token);
      initGlobalWaSocket(token);
    }
  });

  function isActivePath(targetPath, currentPath) {
    if (targetPath === currentPath || (targetPath === '/dashboard.html' && (currentPath === '/' || currentPath === '/index.html'))) {
      return "bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-bold";
    }
    return "text-slate-400 hover:bg-slate-800 font-semibold";
  }

  function injectLayout() {
    const currentPath = window.location.pathname;

    // A. KODE SIDEBAR DESKTOP (Tampil di Layar md: Ke Atas)
    const sidebarHTML = `
      <aside class="hidden md:flex w-64 bg-slate-900 border-r border-slate-800 p-6 flex-col justify-between space-y-6 flex-shrink-0 min-h-screen">
        <div class="space-y-6">
          <!-- Logo & Judul Aplikasi -->
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/30 flex-shrink-0">
              <i data-lucide="bot"></i>
            </div>
            <div class="overflow-hidden">
              <h1 class="font-bold text-base text-slate-100 truncate">WA AutoBot AI</h1>
              <p class="text-[11px] text-slate-400 font-medium truncate">Scheduler Manager</p>
            </div>
          </div>

          <!-- User Profile Badge & Dropdown -->
          <div class="relative">
            <button onclick="toggleUserDropdown()" class="w-full bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 p-3 rounded-xl flex items-center justify-between text-left transition">
              <div class="flex items-center gap-3 overflow-hidden">
                <div class="relative flex-shrink-0">
                  <img id="userAvatar" src="https://api.dicebear.com/7.x/bottts/svg?seed=user" class="w-10 h-10 rounded-full bg-slate-700 object-cover transition-all duration-300">
                  <div id="premiumCrownBadge" class="hidden absolute -top-1 -right-1 bg-amber-400 text-slate-950 p-0.5 rounded-full shadow-md">
                    <i data-lucide="crown" class="w-3 h-3 fill-slate-950"></i>
                  </div>
                </div>
                <div class="overflow-hidden">
                  <p id="userNickname" class="font-semibold text-xs text-slate-200 truncate">Loading...</p>
                  <p id="userPlan" class="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Free Plan</p>
                </div>
              </div>
              <i data-lucide="chevron-down" class="w-4 h-4 text-slate-400 flex-shrink-0 ml-1"></i>
            </button>

            <!-- Dropdown Menu Desktop -->
            <div id="userDropdown" class="hidden absolute left-0 right-0 top-full mt-2 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-1.5 z-50 space-y-1">
              <a href="/profile.html" class="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-semibold transition ${isActivePath('/profile.html', currentPath)}">
                <i data-lucide="user" class="w-4 h-4"></i> Profil Saya
              </a>
              <button onclick="logout()" class="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-semibold text-rose-400 hover:bg-rose-500/10 transition">
                <i data-lucide="log-out" class="w-4 h-4"></i> Keluar
              </button>
            </div>
          </div>

          <!-- Tab Navigasi Desktop -->
          <nav class="space-y-1">
            <a href="/dashboard.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition ${isActivePath('/dashboard.html', currentPath)}">
              <i data-lucide="layout-dashboard" class="w-4 h-4"></i> WA Bot AI
            </a>
            <a href="/schedule.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition ${isActivePath('/schedule.html', currentPath)}">
              <i data-lucide="calendar-clock" class="w-4 h-4"></i> WA Chat Schedule
            </a>
            <a href="/tutorial.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition ${isActivePath('/tutorial.html', currentPath)}">
              <i data-lucide="book-open" class="w-4 h-4"></i> Tutorial & Panduan
            </a>
            <a href="/subscription.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition ${isActivePath('/subscription.html', currentPath)}">
              <i data-lucide="crown" class="w-4 h-4 text-amber-400"></i> Upgrade Premium
            </a>
            <a href="/report.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition ${isActivePath('/report.html', currentPath)}">
              <i data-lucide="help-circle" class="w-4 h-4"></i> Laporkan Kendala
            </a>
          </nav>
        </div>
      </aside>
    `;

    // B. KODE TOPBAR & MOBILE DRAWER NAVIGATION (Dengan Indikator WA Status)
    const topbarHTML = `
      <header class="w-full bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-4 sm:px-6 py-3 flex justify-between items-center sticky top-0 z-40">
        <!-- Brand Logo di HP & Button Hamburger -->
        <div class="flex items-center gap-3">
          <button onclick="toggleMobileMenu()" class="md:hidden p-2 text-slate-300 hover:text-white rounded-xl bg-slate-800 border border-slate-700/60 focus:outline-none" aria-label="Toggle Menu">
            <i id="mobileMenuIcon" data-lucide="menu" class="w-5 h-5"></i>
          </button>
          
          <div class="flex items-center gap-2 md:hidden">
            <div class="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-md shadow-indigo-600/30 flex-shrink-0">
              <i data-lucide="bot" class="w-4 h-4"></i>
            </div>
            <span class="font-bold text-sm text-slate-100">WA AutoBot</span>
          </div>

          <span class="text-xs font-semibold text-slate-400 hidden md:inline">WA AutoBot AI SaaS Management</span>
        </div>

        <!-- Right Side: Indikator WA Connected & Report Button -->
        <div class="flex items-center gap-2.5">
          <!-- Indikator Status WA Connected -->
          <div id="globalWaStatusBadge" class="flex items-center">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 text-slate-400 text-[11px] font-semibold">
              <span class="w-2 h-2 rounded-full bg-slate-500"></span> Memeriksa WA...
            </span>
          </div>

          <button onclick="openReportModal()" class="bg-indigo-600/10 hover:bg-indigo-600/20 border border-indigo-500/20 text-indigo-400 px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition">
            <i data-lucide="alert-circle" class="w-3.5 h-3.5"></i>
            <span class="hidden sm:inline">Report Cepat</span>
          </button>
        </div>
      </header>

      <!-- Mobile Drawer Dropdown Menu -->
      <div id="mobileDrawer" class="hidden md:hidden bg-slate-900 border-b border-slate-800 px-4 py-4 space-y-4 sticky top-[53px] z-30 shadow-2xl">
        <!-- Ringkasan User di Mobile Drawer -->
        <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/50 p-3 rounded-xl">
          <div class="flex items-center gap-3 overflow-hidden">
            <div class="relative flex-shrink-0">
              <img id="mobileUserAvatar" src="https://api.dicebear.com/7.x/bottts/svg?seed=user" class="w-9 h-9 rounded-full bg-slate-700 object-cover">
              <div id="mobilePremiumCrownBadge" class="hidden absolute -top-1 -right-1 bg-amber-400 text-slate-950 p-0.5 rounded-full shadow-md">
                <i data-lucide="crown" class="w-2.5 h-2.5 fill-slate-950"></i>
              </div>
            </div>
            <div class="overflow-hidden">
              <p id="mobileUserNickname" class="font-semibold text-xs text-slate-200 truncate">Loading...</p>
              <p id="mobileUserPlan" class="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Free Plan</p>
            </div>
          </div>
          <button onclick="logout()" class="text-rose-400 hover:bg-rose-500/10 p-2 rounded-xl text-xs font-semibold transition" title="Keluar">
            <i data-lucide="log-out" class="w-4 h-4"></i>
          </button>
        </div>

        <!-- Navigasi Grid 2 Kolom untuk HP -->
        <nav class="grid grid-cols-2 gap-2 text-xs">
          <a href="/profile.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/profile.html', currentPath)}">
            <i data-lucide="user" class="w-4 h-4"></i> Profil Saya
          </a>
          <a href="/dashboard.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/dashboard.html', currentPath)}">
            <i data-lucide="layout-dashboard" class="w-4 h-4"></i> WA Bot AI
          </a>
          <a href="/schedule.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/schedule.html', currentPath)}">
            <i data-lucide="calendar-clock" class="w-4 h-4"></i> Schedule
          </a>
          <a href="/tutorial.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/tutorial.html', currentPath)}">
            <i data-lucide="book-open" class="w-4 h-4"></i> Panduan
          </a>
          <a href="/subscription.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/subscription.html', currentPath)}">
            <i data-lucide="crown" class="w-4 h-4 text-amber-400"></i> Upgrade
          </a>
          <a href="/report.html" class="flex items-center gap-2 p-2.5 rounded-xl transition ${isActivePath('/report.html', currentPath)}">
            <i data-lucide="help-circle" class="w-4 h-4"></i> Lapor
          </a>
        </nav>
      </div>
    `;

    // C. POP-UP MODAL REPORT
    const modalHTML = `
      <div id="reportModal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm hidden flex items-center justify-center p-4 z-50">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 max-w-lg w-full space-y-4 shadow-2xl relative">
          <div class="flex justify-between items-center border-b border-slate-800 pb-3">
            <h3 class="font-bold text-xs sm:text-sm text-slate-100 flex items-center gap-2">
              <i data-lucide="life-buoy" class="w-4 h-4 text-indigo-400"></i> Kirim Laporan Kendala Cepat
            </h3>
            <button onclick="closeReportModal()" class="text-slate-400 hover:text-white"><i data-lucide="x" class="w-4 h-4"></i></button>
          </div>

          <form onsubmit="submitModalReport(event)" class="space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Kategori Kendala</label>
              <select id="modalCategorySelect" required class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs focus:outline-none focus:border-indigo-500 text-slate-200">
                <option value="Kendala BOT WA Tidak berjalan">Kendala BOT WA Tidak berjalan</option>
                <option value="Tidak terkoneksi ke WA">Tidak terkoneksi ke WA</option>
                <option value="Pembayaran Langganan">Pembayaran Langganan</option>
                <option value="Auto-Generate Prompt Error">Auto-Generate Prompt Error</option>
                <option value="Kuota Bulanan Bermasalah">Kuota Bulanan Bermasalah</option>
                <option value="Respon AI Lambat">Respon AI Lambat</option>
                <option value="Spam Balasan / Duplicate Chat">Spam Balasan / Duplicate Chat</option>
                <option value="Masalah Akun & Akses Login">Masalah Akun & Akses Login</option>
                <option value="Lainnya">Lainnya</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Subjek Laporan</label>
              <input type="text" id="modalSubjectInput" required placeholder="Judul masalah..." class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs focus:outline-none focus:border-indigo-500">
            </div>

            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">Detail Kendala</label>
              <textarea id="modalMessageInput" rows="4" required placeholder="Jelaskan masalah kamu..." class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs focus:outline-none focus:border-indigo-500 leading-relaxed"></textarea>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-800">
              <a href="/report.html" class="text-xs text-indigo-400 hover:underline font-semibold flex items-center gap-1">
                Tiket Saya <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
              </a>
              <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-5 py-2.5 rounded-xl transition shadow-lg shadow-indigo-600/20">
                Kirim Laporan
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    // Sisipkan Sidebar
    const sidebarTarget = document.getElementById("app-sidebar") || document.querySelector("aside");
    if (sidebarTarget) sidebarTarget.outerHTML = sidebarHTML;
    else document.body.insertAdjacentHTML("afterbegin", sidebarHTML);

    // Sisipkan Topbar Header
    const topbarTarget = document.getElementById("app-topbar") || document.querySelector("header");
    const mainArea = document.querySelector("main");
    if (topbarTarget) topbarTarget.outerHTML = topbarHTML;
    else if (mainArea) mainArea.insertAdjacentHTML("beforebegin", topbarHTML);

    // Sisipkan Modal jika belum ada
    if (!document.getElementById("reportModal")) {
      document.body.insertAdjacentHTML("beforeend", modalHTML);
    }
  }

  // --- REALTIME SOCKET WA STATUS INDICATOR ENGINE ---
  function initGlobalWaSocket(token) {
    if (typeof io === "undefined") return;

    if (!socketInstance) {
      socketInstance = io();
      socketInstance.emit("start-bot", token);
    }

    socketInstance.on("status", (status) => {
      updateWaStatusBadge(status);
    });
  }

  function updateWaStatusBadge(status) {
    const badgeContainer = document.getElementById("globalWaStatusBadge");
    if (!badgeContainer) return;

    if (status === "Connected") {
      badgeContainer.innerHTML = `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-bold shadow-sm">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>WA Connected</span>
        </span>
      `;
    } else if (status === "Scan QR Code") {
      badgeContainer.innerHTML = `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-bold shadow-sm">
          <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
          <span>Scan QR Code</span>
        </span>
      `;
    } else {
      badgeContainer.innerHTML = `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[11px] font-bold shadow-sm">
          <span class="w-2 h-2 rounded-full bg-rose-400"></span>
          <span>WA Disconnected</span>
        </span>
      `;
    }
  }

  // --- HANDLER KONTROL USER & MOBILE DRAWER ---
  window.toggleMobileMenu = function() {
    const drawer = document.getElementById("mobileDrawer");
    if (drawer) {
      drawer.classList.toggle("hidden");
      if (typeof lucide !== "undefined") lucide.createIcons();
    }
  };

  window.toggleUserDropdown = function() {
    const dropdown = document.getElementById("userDropdown");
    if (dropdown) dropdown.classList.toggle("hidden");
  };

  window.openReportModal = function() {
    const modal = document.getElementById("reportModal");
    if (modal) modal.classList.remove("hidden");
    document.getElementById("userDropdown")?.classList.add("hidden");
    document.getElementById("mobileDrawer")?.classList.add("hidden");
  };

  window.closeReportModal = function() {
    const modal = document.getElementById("reportModal");
    if (modal) modal.classList.add("hidden");
  };

  window.submitModalReport = async function(e) {
    e.preventDefault();
    const token = localStorage.getItem("token");
    const category = document.getElementById("modalCategorySelect").value;
    const subject = document.getElementById("modalSubjectInput").value;
    const message = document.getElementById("modalMessageInput").value;

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ category, subject, message })
      });

      const data = await res.json();
      alert(data.message);

      if (data.success) {
        closeReportModal();
        document.getElementById("modalSubjectInput").value = "";
        document.getElementById("modalMessageInput").value = "";
      }
    } catch {
      alert("Gagal mengirimkan laporan.");
    }
  };

  window.logout = function() {
    localStorage.removeItem("token");
    window.location.href = "/login.html";
  };

  window.addEventListener("click", (e) => {
    const dropdown = document.getElementById("userDropdown");
    const btn = e.target.closest("button[onclick='toggleUserDropdown()']");
    if (dropdown && !dropdown.contains(e.target) && !btn) {
      dropdown.classList.add("hidden");
    }
  });

  async function loadGlobalUserProfile(token) {
    try {
      const res = await fetch("/api/config", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await res.json();
      if (!data) return;

      const nicknameEls = [document.getElementById("userNickname"), document.getElementById("mobileUserNickname")];
      const planEls = [document.getElementById("userPlan"), document.getElementById("mobileUserPlan")];
      const avatarEls = [document.getElementById("userAvatar"), document.getElementById("mobileUserAvatar")];
      const crownBadges = [document.getElementById("premiumCrownBadge"), document.getElementById("mobilePremiumCrownBadge")];

      nicknameEls.forEach(el => { if (el) el.innerText = data.nickname || "User"; });
      avatarEls.forEach(el => { if (el && data.profilePicture) el.src = data.profilePicture; });

      const isPremium = data.plan === "premium";
      planEls.forEach(el => {
        if (el) {
          el.innerText = isPremium ? "Premium Plan" : "Free Plan";
          el.className = isPremium 
            ? "text-[10px] text-amber-400 font-bold uppercase tracking-wider" 
            : "text-[10px] text-indigo-400 font-bold uppercase tracking-wider";
        }
      });

      crownBadges.forEach(badge => {
        if (badge) {
          if (isPremium) badge.classList.remove("hidden");
          else badge.classList.add("hidden");
        }
      });
    } catch (err) {
      console.error("Load user profile error:", err);
    }
  }
})();
document.addEventListener("DOMContentLoaded", () => {
  const token = localStorage.getItem("token");
  if (!token) return;

  // 1. Elemen Badge Indikator Status
  const statusContainer = document.createElement("div");
  statusContainer.id = "globalWaStatusBadge";
  statusContainer.className = "flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 border border-slate-800 shadow-lg transition-all duration-300";
  statusContainer.innerHTML = `
    <span id="globalWaStatusDot" class="w-2.5 h-2.5 rounded-full bg-slate-500 animate-pulse"></span>
    <span id="globalWaStatusText" class="text-slate-400">Memeriksa WA...</span>
  `;

  // 2. Utamakan pasang di Slot Target Khusus (#waStatusTarget) jika tersedia
  const targetSlot = document.getElementById("waStatusTarget");
  const headerContainer = document.querySelector("main .flex-col.sm\\:flex-row") || document.querySelector("header");

  if (targetSlot) {
    targetSlot.appendChild(statusContainer);
  } else if (headerContainer) {
    headerContainer.appendChild(statusContainer);
  } else {
    statusContainer.classList.add("fixed", "top-4", "right-4", "z-50");
    document.body.appendChild(statusContainer);
  }

  // 3. Socket.IO Listener Realtime
  if (typeof io !== "undefined") {
    const socket = io();
    socket.emit("start-bot", token);

    socket.on("status", (status) => {
      const dot = document.getElementById("globalWaStatusDot");
      const text = document.getElementById("globalWaStatusText");
      if (!dot || !text) return;

      if (status === "Connected") {
        dot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50";
        text.className = "text-emerald-400 font-bold";
        text.innerText = "WA Connected";
      } else if (status === "Disconnected" || status === "Unauthorized") {
        dot.className = "w-2.5 h-2.5 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50";
        text.className = "text-rose-400 font-bold";
        text.innerText = "WA Terputus";
      } else {
        dot.className = "w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping";
        text.className = "text-amber-400 font-medium";
        text.innerText = status || "Menghubungkan...";
      }
    });
  }
});
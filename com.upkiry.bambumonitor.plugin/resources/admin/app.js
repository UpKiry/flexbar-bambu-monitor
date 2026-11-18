"use strict";

/**
 * Bambu Monitor 本机浏览器后台。
 *
 * 这是一个无构建的静态页面：只通过同源 fetch 调用插件后台的 /api/*，
 * 不直接访问 Bambu 云，也不把令牌写进 localStorage。
 */
(function () {
  const TOKEN_KEY = "bambu-monitor-admin-token";
  const STATUS_POLL_MS = 1_000;
  const DIAGNOSTICS_POLL_MS = 2_500;
  const ACTION_BUTTON_IDS = [
    "refresh-btn",
    "login-btn",
    "send-code-btn",
    "switch-password-btn",
    "logout-btn",
    "refresh-devices-btn",
    "test-connection-btn",
    "full-state-btn",
    "refresh-diag-btn",
  ];

  const state = {
    token: "",
    status: null,
    diagnostics: null,
    awaitingCode: false,
    busy: false,
    statusTimer: null,
    diagnosticsTimer: null,
    requests: { status: null, diagnostics: null },
    generation: 0,
    statusFailures: 0,
    lastStatusAt: null,
    serviceUnavailable: false,
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value === undefined || value === null ? "" : String(value);
  }

  function setHidden(id, hidden) {
    const node = $(id);
    if (node) node.hidden = Boolean(hidden);
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // ---------------------------------------------------------------------
  // 令牌
  // ---------------------------------------------------------------------

  function readHashToken() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return "";
    try {
      return new URLSearchParams(raw).get("token") || "";
    } catch {
      return "";
    }
  }

  function storedToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  function persistToken(token) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // 隐私模式下 sessionStorage 不可用时，退化为仅当前页面内存。
    }
  }

  function clearStoredToken() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  }

  function stripTokenFromAddress() {
    if (!location.hash) return;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      // ignore
    }
  }

  function extractToken(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      if (text.includes("#token=")) return decodeURIComponent(text.split("#token=")[1]);
      if (/^https?:\/\//i.test(text)) {
        const parsed = new URL(text);
        return new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") || "";
      }
    } catch {
      return "";
    }
    return text;
  }

  // ---------------------------------------------------------------------
  // 请求
  // ---------------------------------------------------------------------

  async function api(path, { method = "GET", body } = {}) {
    const requestToken = state.token;
    const headers = { Authorization: `Bearer ${requestToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (response.status === 401) {
      if (state.token === requestToken) showTokenScreen("后台令牌无效或已过期，请从 FlexDesigner 设置页重新点击「进入后台」。");
      throw new Error("后台令牌无效");
    }
    if (!response.ok) {
      throw new Error(data.message || `请求失败（HTTP ${response.status}）`);
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // 页面状态
  // ---------------------------------------------------------------------

  function showMessage(text, type = "") {
    const node = $("message");
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = "";
      return;
    }
    node.hidden = false;
    node.className = `message${type ? ` ${type}` : ""}`;
    node.textContent = text;
  }

  function showBanner(text, type = "") {
    const node = $("banner");
    if (!node) return;
    if (!text) {
      node.hidden = true;
      node.textContent = "";
      return;
    }
    node.hidden = false;
    node.className = `banner${type ? ` ${type}` : ""}`;
    node.textContent = text;
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    for (const id of ACTION_BUTTON_IDS) {
      const node = $(id);
      if (node) node.disabled = state.busy;
    }
    const region = $("region-select");
    const printer = $("printer-select");
    if (region) region.disabled = state.busy || state.awaitingCode || Boolean(state.status?.auth?.state === "signed-in");
    const account = $("account-input");
    if (account) account.readOnly = state.awaitingCode || state.busy;
    if (printer) printer.disabled = state.busy;
  }

  function setPill(text, className) {
    const node = $("auth-pill");
    if (!node) return;
    node.textContent = text;
    node.className = `pill ${className}`;
  }

  function startPolling() {
    stopPolling();
    state.statusTimer = setInterval(() => {
      if (!document.hidden && state.token && !state.busy) loadStatus({ silent: true });
    }, STATUS_POLL_MS);
    state.diagnosticsTimer = setInterval(() => {
      if (!document.hidden && state.token) loadDiagnostics({ silent: true });
    }, DIAGNOSTICS_POLL_MS);
  }

  function stopPolling() {
    if (state.statusTimer) clearInterval(state.statusTimer);
    if (state.diagnosticsTimer) clearInterval(state.diagnosticsTimer);
    state.statusTimer = null;
    state.diagnosticsTimer = null;
  }

  // 同一端点只保留一个请求；操作完成后等待旧请求结束，再读取新状态。
  async function loadStatus({ silent = false, fresh = false } = {}) {
    if (!state.token) return;
    if (state.requests.status) {
      if (!fresh) return state.requests.status;
      await state.requests.status;
      if (!state.token) return;
      if (state.requests.status) return loadStatus({ silent, fresh });
    }
    const generation = state.generation;
    const request = (async () => {
      try {
        const data = await api("/api/status");
        if (generation !== state.generation || !state.token) return;
        state.statusFailures = 0;
        state.lastStatusAt = Date.now();
        if (state.serviceUnavailable) {
          state.serviceUnavailable = false;
          setHidden("service-warning", true);
          showMessage("本地服务连接已恢复，状态已更新。", "success");
        } else if (!silent) showMessage("状态已刷新", "success");
        state.status = data;
        renderStatus(data);
      } catch (error) {
        if (generation !== state.generation || !state.token) return;
        state.statusFailures += 1;
        if (state.statusFailures >= 2) {
          state.serviceUnavailable = true;
          const lastUpdate = state.lastStatusAt === null ? "尚未成功读取状态。" : `最后成功更新：${formatDateTime(state.lastStatusAt)}。`;
          setText("service-warning", `无法连接本地服务，页面显示的可能是旧状态；${lastUpdate}请检查插件是否运行。恢复连接后会自动更新。`);
          setHidden("service-warning", false);
        }
        if (!silent) showMessage(error.message, "error");
      }
    })();
    state.requests.status = request;
    try { await request; } finally {
      if (state.requests.status === request) state.requests.status = null;
    }
  }

  async function loadDiagnostics({ silent = false, fresh = false } = {}) {
    if (!state.token) return;
    if (state.requests.diagnostics) {
      if (!fresh) return state.requests.diagnostics;
      await state.requests.diagnostics;
      if (!state.token) return;
      if (state.requests.diagnostics) return loadDiagnostics({ silent, fresh });
    }
    const generation = state.generation;
    const request = (async () => {
      try {
        const data = await api("/api/diagnostics");
        if (generation !== state.generation || !state.token) return;
        state.diagnostics = data;
        renderDiagnostics(data);
        if (!silent) showMessage("诊断信息已刷新", "success");
      } catch (error) {
        if (generation === state.generation && !silent && state.token) showMessage(error.message, "error");
      }
    })();
    state.requests.diagnostics = request;
    try { await request; } finally {
      if (state.requests.diagnostics === request) state.requests.diagnostics = null;
    }
  }

  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------

  function currentRegion() {
    return state.status?.config?.region || "global";
  }

  function accountKindError(account) {
    const region = currentRegion();
    const hasEmail = typeof account === "string" && account.includes("@");
    if (region === "china" && hasEmail) return "中国大陆账号只能使用手机号登录";
    if (region !== "china" && !hasEmail) return "全球账号请使用邮箱登录";
    return "";
  }

  function renderAccountField(region) {
    const china = region === "china";
    const label = $("account-label");
    if (label) label.textContent = china ? "Bambu 账号（手机号）" : "Bambu 账号（邮箱）";
    const input = $("account-input");
    if (input) {
      input.type = china ? "tel" : "email";
      input.autocomplete = china ? "tel" : "username";
      input.inputMode = china ? "tel" : "email";
      input.placeholder = china ? "例如 +86 13800138000" : "name@example.com";
    }
    const hint = $("account-hint");
    if (hint) {
      hint.textContent = china
        ? "中国大陆账号使用手机号登录，验证码通过短信发送。"
        : "全球账号使用邮箱登录，验证码通过邮件发送。";
    }
  }

  function renderStatus(data) {
    const auth = data.auth || {};
    const config = data.config || {};
    const signedIn = auth.state === "signed-in";
    const expired = auth.state === "expired";

    if (signedIn) setPill("已登录", "signed-in");
    else if (expired) setPill("登录已失效", "expired");
    else setPill("未登录", "muted");

    const regionLabel = labelForRegion(config.region, data.regions);
    setText("region-badge", regionLabel);

    setHidden("login-form", signedIn);
    setHidden("signed-in-panel", !signedIn);
    if (signedIn) {
      state.awaitingCode = false;
      setText("account-state", "已登录");
      setText("account-uid", auth.userId || "—");
      setText("account-expiry", formatDateTime(auth.expiresAt));
    } else {
      setText("account-state", expired ? "登录已失效" : "未登录");
      setText("account-uid", "—");
      setText("account-expiry", "—");
    }

    const credential = data.credentialStore || {};
    setText("credential-store", credential.available
      ? `系统安全存储可用（${credential.backend || "system"}）`
      : `仅内存保存（${credential.reason || "安全存储不可用"}）`);

    renderRegionSelect(data.regions, config.region, signedIn);
    renderBanner(data, signedIn, expired);
    renderDevices(data, signedIn);
    renderSnapshot(data);
    renderLoginMode();
    setBusy(state.busy);
    setText("admin-port", data.admin?.port ? `本地端口 ${data.admin.port}` : "");
  }

  function renderBanner(data, signedIn, expired) {
    const messages = [];
    let level = "warning";
    if (expired) {
      messages.push("登录已失效，请在下方重新登录。");
      level = "error";
    }
    if (data.auth?.error?.message) {
      messages.push(data.auth.error.message);
      level = "error";
    }
    if (data.credentialStore?.available === false) {
      messages.push("系统安全存储不可用：登录状态只保留到插件重启为止。");
    }
    if (data.devicesError) {
      messages.push(`读取设备列表失败：${data.devicesError}`);
    }
    if (!signedIn && data.admin && data.admin.running === false) {
      messages.push("本地后台未运行，请回到 FlexDesigner 设置页重新进入。");
    }
    if (!messages.length) {
      showBanner("", "");
      return;
    }
    showBanner(messages.join("；"), level);
  }

  function renderRegionSelect(regions, current, signedIn) {
    const select = $("region-select");
    if (!select) return;
    const items = Array.isArray(regions) && regions.length ? regions : [
      { id: "global", label: "全球" },
      { id: "china", label: "中国大陆" },
    ];
    const signature = items.map((item) => item.id).join(",");
    if (select.dataset.signature !== signature) {
      clear(select);
      for (const item of items) {
        const option = create("option", "", item.label);
        option.value = item.id;
        select.appendChild(option);
      }
      select.dataset.signature = signature;
    }
    select.value = current || "global";
    select.disabled = state.busy || signedIn || state.awaitingCode;
    setText("region-hint", signedIn
      ? "退出登录后才能切换区域。"
      : current === "china"
        ? "中国大陆账号只能使用手机号登录，验证码通过短信发送。"
        : "全球账号使用邮箱登录，验证码通过邮件发送；区域选错会登录失败。");
    renderAccountField(current || "global");
  }

  function renderLoginMode() {
    const awaiting = state.awaitingCode;
    const channel = currentRegion() === "china" ? "短信" : "邮箱";
    setHidden("password-field", awaiting);
    setHidden("code-field", !awaiting);
    setText("code-label", `${channel}验证码`);
    setText("code-hint", `验证码会发送到账号${channel === "短信" ? "手机" : "邮箱"}。若没有收到，可以重新发送。`);
    setText("login-btn", awaiting ? "提交验证码" : "登录");
    setText("send-code-btn", awaiting ? `重新发送${channel}验证码` : `发送${channel}验证码`);
    setHidden("switch-password-btn", !awaiting);
    setBusy(state.busy);
  }

  function renderDevices(data, signedIn) {
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const selected = data.config?.printerId || "";
    const hasSelection = Boolean(selected);
    const showPanel = signedIn && (devices.length > 0 || hasSelection);

    setHidden("device-empty", showPanel);
    setHidden("device-panel", !showPanel);

    if (!showPanel) {
      if (!signedIn) setText("device-empty", "登录后可以读取账号下绑定的打印机。");
      else if (data.devicesError) setText("device-empty", `读取设备列表失败：${data.devicesError}`);
      else setText("device-empty", "账号下没有绑定打印机，请先在 Bambu 应用或 Bambu Studio 中绑定设备。");
      setText("link-state", "未连接");
      return;
    }

    const select = $("printer-select");
    const selectedMissing = hasSelection && !devices.some((device) => device.id === selected);
    const signature = JSON.stringify([devices.map((device) => [device.id, device.name, device.model, device.online]), selectedMissing ? selected : ""]);
    if (select.dataset.signature !== signature) {
      clear(select);
      const none = create("option", "", "不监控任何设备");
      none.value = "";
      select.appendChild(none);
      for (const device of devices) {
        const suffix = device.online === true ? "（在线）" : device.online === false ? "（离线）" : "（在线状态未知）";
        const model = device.model ? ` · ${device.model}` : "";
        const option = create("option", "", `${device.name || device.id}${model}${suffix}`);
        option.value = device.id;
        select.appendChild(option);
      }
      if (selectedMissing) {
        const option = create("option", "", `当前选择（${selected}，不在设备列表中）`);
        option.value = selected;
        select.appendChild(option);
      }
      select.dataset.signature = signature;
    }
    select.value = selected;
    select.disabled = state.busy;

    const count = devices.length;
    setText("device-hint", data.monitorBlockMessage || (data.devicesError
      ? data.devicesError
      : count
        ? `共 ${count} 台设备，只监控当前选中的一台。`
        : "设备列表暂不可用，但仍显示当前选择的打印机。"));

    const printer = data.printer || {};
    const link = printer.link || {};
    const linkState = link.state || "idle";
    const linkText = labelForLink(linkState, link);
    setText("link-state", linkText);
    const linkNode = $("link-state");
    if (linkNode) linkNode.className = `link-${linkState}`;

    const printerState = printer.state || {};
    setText("last-report", printerState.lastReportAt
      ? `${formatTime(printerState.lastReportAt)}（${formatAge(printerState.lastReportAt)}）`
      : "尚未收到");
    const freshness = printerState.freshness || {};
    const fields = freshness.fields || {};
    setText("activity", withFreshness(labelForActivity(printerState.activity, printerState.rawActivity), fields.activity));
    setText("task-name", withFreshness(printerState.taskName || "—", fields.taskName));
    setText("layer-text", `${withFreshness(Number.isFinite(printerState.layerNum) && printerState.layerNum >= 0 ? printerState.layerNum : "未知", fields.layerNum)} / ${withFreshness(Number.isFinite(printerState.totalLayerNum) && printerState.totalLayerNum >= 0 ? printerState.totalLayerNum : "未知", fields.totalLayerNum)}`);
    setText("progress-text", withFreshness(formatPercent(printerState.progressPercent), fields.progressPercent));
    setText("remaining-text", withFreshness(formatMinutes(printerState.remainingMinutes), fields.remainingMinutes));
    setText("nozzle-text", formatTemperature(printerState.nozzle, fields["nozzle.current"], fields["nozzle.target"]));
    setText("bed-text", formatTemperature(printerState.bed, fields["bed.current"], fields["bed.target"]));
    setText("error-code", `print_error：${formatErrorChannel(printerState.printError, fields.printError)} · mc_print_error_code：${formatErrorChannel(printerState.printErrorCode, fields.printErrorCode)}`);
    const hasReport = Number.isFinite(printerState.lastReportAt);
    setText("report-freshness", !hasReport
      ? "尚未收到设备状态，无法判断当前状态。"
      : linkState !== "connected" || printerState.reportStale === true
        ? "设备状态可能是断连前的旧数据，等待新的设备报文。"
        : Date.now() - printerState.lastReportAt > 5 * 60 * 1000
          ? "超过 5 分钟未收到设备报文；部分字段可能保留更早的数据。"
          : "最近报文时间不代表所有字段的更新时间；部分字段可能保留较早的数据。");
    renderHms(printerState.hms, fields.hms);
    renderAms(printerState.ams, freshness.ams);

    const progress = $("progress-bar");
    if (progress) {
      if (typeof printerState.progressPercent === "number" && Number.isFinite(printerState.progressPercent)) {
        progress.hidden = false;
        progress.value = Math.max(0, Math.min(100, printerState.progressPercent));
      } else {
        progress.hidden = true;
      }
    }
  }

  function renderAms(ams, freshness) {
    const list = $("ams-list");
    clear(list);
    const units = Array.isArray(ams?.units) ? ams.units : null;
    setText("ams-empty", units === null ? (ams && Object.hasOwn(ams, "units") ? "AMS 列表未知" : "尚无 AMS 数据") : units.length ? "" : "已上报空 AMS 列表");
    if (!list || !ams) return;
    if (ams.rawStatus !== null && ams.rawStatus !== undefined) {
      list.appendChild(create("li", "status-item", `AMS 状态原始值：${withFreshness(ams.rawStatus, freshness?.fields?.rawStatus)}`));
    }
    if (ams.rawTrayNow !== null && ams.rawTrayNow !== undefined && (!ams.current || !units)) {
      list.appendChild(create("li", "status-item", `当前耗材原始值：${withFreshness(ams.rawTrayNow, freshness?.fields?.rawTrayNow)}`));
    }
    for (const unit of units || []) {
      if (!unit || typeof unit !== "object") continue;
      const slots = Array.isArray(unit.slots) ? unit.slots : null;
      if (!slots) {
        list.appendChild(create("li", "status-item", `AMS ${unit.id ?? "未知"}：暂无槽位数据，槽位信息未知`));
        continue;
      }
      if (!slots.length) list.appendChild(create("li", "status-item", `AMS ${unit.id ?? "未知"}：已上报空槽位列表`));
      for (const slot of slots) {
        if (!slot || typeof slot !== "object") continue;
        const item = create("li", "status-item");
        const exists = slot.exists === true ? "存在" : slot.exists === false ? "空槽" : "未知";
        const label = `AMS ${unit.id ?? "未知"} · 槽位 ${slot.id ?? "未知"}`;
        const slotFreshness = freshness?.units?.[unit.id]?.slots?.[slot.id] || {};
        // 仅凭仍然新鲜的空槽观察隐藏旧耗材；过期或未知观察不应遮住新报告的字段。
        const observedAt = slotFreshness.exists?.at;
        const now = Date.now();
        const confirmedEmpty = slot.exists === false && slotFreshness.exists?.stale === false &&
          Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= 5 * 60 * 1000;
        if (confirmedEmpty) {
          item.appendChild(create("span", "", `${label} · 耗材：${withFreshness(exists, slotFreshness.exists)}`));
          list.appendChild(item);
          continue;
        }
        const color = typeof slot.color === "string" && /^[0-9a-f]{8}$/i.test(slot.color) ? slot.color : null;
        if (color) {
          const swatch = create("span", "ams-color");
          swatch.style.backgroundColor = `#${color}`;
          swatch.setAttribute("aria-hidden", "true");
          item.appendChild(swatch);
        }
        const active = ams.current && String(ams.current.unitId) === String(unit.id) && String(ams.current.slotId) === String(slot.id);
        const remaining = Number.isFinite(slot.remaining) && slot.remaining >= 0 && slot.remaining <= 100 ? `${slot.remaining}%` : "未知";
        const rawState = slot.rawState === null || slot.rawState === undefined || slot.rawState === "" ? "未知" : String(slot.rawState);
        const currentLabel = active ? `（${withFreshness("当前", freshness?.fields?.current)}）` : "";
        item.appendChild(create("span", "", `${label}${currentLabel} · 耗材：${withFreshness(exists, slotFreshness.exists)} · 材质：${withFreshness(slot.material || "未知", slotFreshness.material)} · 颜色：${withFreshness(color ? `#${color}` : "未知", slotFreshness.color)} · 余量：${withFreshness(remaining, slotFreshness.remaining)} · 状态原始值：${withFreshness(rawState, slotFreshness.rawState)}`));
        list.appendChild(item);
      }
    }
  }

  function formatErrorChannel(value, freshness) {
    const text = value === null || value === undefined ? "未知"
      : value === 0 ? "已清除（0）" : `原始码 ${value}`;
    return withFreshness(text, freshness);
  }

  function renderHms(hms, freshness) {
    const list = $("hms-list");
    clear(list);
    const entries = Array.isArray(hms) ? hms.filter((item) => item && typeof item === "object") : null;
    setText("hms-empty", entries === null ? "故障信息未知" : entries.length ? "" : withFreshness("当前无已上报的 HMS 故障", freshness));
    if (!list || !entries) return;
    for (const entry of entries) {
      const fields = [["代码", entry.code], ["属性", entry.attr], ["模块", entry.module]]
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([label, value]) => `${label}：${value}`);
      list.appendChild(create("li", "status-item", withFreshness(fields.length ? fields.join(" · ") : "故障详情未知", freshness)));
    }
  }

  function formatLayers(current, total) {
    const valid = (value) => Number.isFinite(value) && value >= 0;
    if (!valid(current) && !valid(total)) return "—";
    return `${valid(current) ? current : "未知"} / ${valid(total) ? total : "未知"}`;
  }

  function renderSnapshot(data) {
    const snapshot = diagnosticExport().status;
    const text = JSON.stringify(snapshot, null, 2);
    const node = $("snapshot");
    if (node && node.textContent !== text) node.textContent = text;
  }

  function renderDiagnostics(data) {
    const requests = Array.isArray(data.requests) ? data.requests : [];
    const tbody = $("requests-body");
    if (tbody) {
      clear(tbody);
      for (const request of requests) {
        const row = create("tr");
        row.appendChild(create("td", "", formatTime(request.at)));
        row.appendChild(create("td", "", request.method || "—"));
        row.appendChild(create("td", "", request.path || "—"));
        row.appendChild(create("td", "", request.status === null || request.status === undefined ? "—" : request.status));
        row.appendChild(create("td", "", request.kind || "—"));
        row.appendChild(create("td", "", formatDuration(request.durationMs)));
        tbody.appendChild(row);
      }
    }
    setHidden("requests-empty", requests.length > 0);

    const logs = Array.isArray(data.logs) ? data.logs : [];
    const list = $("logs-list");
    if (list) {
      clear(list);
      for (const entry of logs) {
        const item = create("li");
        item.appendChild(create("span", "log-time", formatTime(entry.at)));
        item.appendChild(create("span", `log-level ${entry.level || "info"}`, entry.level || "info"));
        item.appendChild(create("span", "log-message", entry.message || ""));
        list.appendChild(item);
      }
    }
    setHidden("logs-empty", logs.length > 0);
  }

  // ---------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------

  async function runAction(action, payload = {}) {
    if (!state.token || state.busy) return null;
    setBusy(true);
    state.generation += 1;
    try {
      const response = await api("/api/action", {
        method: "POST",
        body: { action, payload },
      });
      const result = response.result || {};
      handleActionResult(action, result);
      await loadStatus({ silent: true, fresh: true });
      await loadDiagnostics({ silent: true, fresh: true });
      return result;
    } catch (error) {
      if (state.token) showMessage(error.message, "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function handleActionResult(action, result) {
    const status = result?.status;
    if (action === "requestFullState" && typeof result?.sent === "boolean") {
      if (result.sent) showMessage("完整状态请求已提交，等待设备上报。", "success");
      else if (result.reason === "cooldown") {
        const seconds = Number.isFinite(result.retryInMs) ? Math.max(1, Math.ceil(result.retryInMs / 1000)) : null;
        showMessage(seconds ? `请求过于频繁，请在 ${seconds} 秒后重试。` : "请求过于频繁，请稍后重试。", "warning");
      } else if (result.reason === "not-connected") showMessage("当前未连接云端，无法请求完整状态。", "warning");
      else showMessage("完整状态请求发送失败，请稍后重试。", "error");
      return;
    }
    if (status === "code-required") {
      state.awaitingCode = true;
      renderLoginMode();
      showMessage(`请输入${currentRegion() === "china" ? "短信" : "邮箱"}验证码`, "warning");
      const password = $("password-input");
      if (password) password.value = "";
      const code = $("code-input");
      if (code) code.focus();
      return;
    }
    if (status === "code-sent") {
      state.awaitingCode = true;
      renderLoginMode();
      showMessage(`验证码已发送，请查收${currentRegion() === "china" ? "短信" : "邮箱"}`, "success");
      const code = $("code-input");
      if (code) code.focus();
      return;
    }
    if (status === "unsupported") {
      showMessage(result.message || "该账号需要双重认证，当前版本尚不支持", "error");
      return;
    }
    if (status === "error" || status === "failed") {
      showMessage(result.message || "操作失败", "error");
      return;
    }
    if (status === "busy") {
      showMessage(result.message || "正在处理，请稍候", "warning");
      return;
    }
    if (status === "success") {
      if (action === "cancelCode") {
        state.awaitingCode = false;
        const code = $("code-input");
        if (code) code.value = "";
        renderLoginMode();
      }
      if (action === "login") {
        state.awaitingCode = false;
        const password = $("password-input");
        const code = $("code-input");
        if (password) password.value = "";
        if (code) code.value = "";
      }
      if (action === "logout") {
        state.awaitingCode = false;
        const password = $("password-input");
        const code = $("code-input");
        if (password) password.value = "";
        if (code) code.value = "";
      }
      showMessage(messageForAction(action, result), "success");
      return;
    }
    showMessage(result?.message || "操作完成", "");
  }

  function messageForAction(action, result) {
    switch (action) {
      case "login": return "登录成功";
      case "cancelCode": return "已取消验证码登录";
      case "logout": return "已退出登录";
      case "refreshDevices": return `已刷新设备列表（${Array.isArray(result?.devices) ? result.devices.length : 0} 台）`;
      case "setPrinter": return "已更新要显示的打印机";
      case "setRegion": return "账号区域已更新";
      case "requestFullState": return result?.sent ? "已请求完整状态" : "请求完整状态失败";
      case "testConnection": return result?.message || "连接测试完成";
      default: return "操作完成";
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const accountNode = $("account-input");
    const passwordNode = $("password-input");
    const codeNode = $("code-input");
    const account = accountNode ? accountNode.value.trim() : "";
    const password = passwordNode ? passwordNode.value : "";
    const code = codeNode ? codeNode.value.trim() : "";

    if (!account) {
      showMessage(currentRegion() === "china" ? "请先填写 Bambu 账号手机号" : "请先填写 Bambu 账号邮箱", "error");
      return;
    }
    const kindError = accountKindError(account);
    if (kindError) {
      showMessage(kindError, "error");
      return;
    }
    if (state.awaitingCode && !code) {
      showMessage("请输入验证码", "error");
      return;
    }
    if (!state.awaitingCode && !password) {
      showMessage("请输入密码，或先发送验证码", "error");
      return;
    }

    const result = await runAction("login", state.awaitingCode ? { account, code } : { account, password });
    // 无论成功失败，都不在输入框里保留密码和验证码。
    if (passwordNode) passwordNode.value = "";
    if (codeNode) codeNode.value = "";
    if (result?.status === "success") {
      state.awaitingCode = false;
      renderLoginMode();
    }
  }

  async function sendCode() {
    const accountNode = $("account-input");
    const account = accountNode ? accountNode.value.trim() : "";
    if (!account) {
      showMessage(currentRegion() === "china" ? "请先填写 Bambu 账号手机号" : "请先填写 Bambu 账号邮箱", "error");
      return;
    }
    const kindError = accountKindError(account);
    if (kindError) {
      showMessage(kindError, "error");
      return;
    }
    const result = await runAction("requestCode", { account });
    if (result?.status === "code-sent" || result?.status === "code-required") {
      state.awaitingCode = true;
      renderLoginMode();
      const code = $("code-input");
      if (code) code.focus();
    }
    if (result?.status === "success") {
      state.awaitingCode = false;
      renderLoginMode();
    }
  }

  async function logout() {
    if (!window.confirm("退出登录后需要重新输入账号密码，确定吗？")) return;
    const result = await runAction("logout");
    if (result?.status === "success") {
      state.awaitingCode = false;
      const password = $("password-input");
      const code = $("code-input");
      if (password) password.value = "";
      if (code) code.value = "";
      renderLoginMode();
    }
  }

  async function setRegion() {
    const select = $("region-select");
    if (!select) return;
    if (state.awaitingCode) return;
    const region = select.value;
    const previous = state.status?.config?.region;
    if (!region || region === previous) return;
    const result = await runAction("setRegion", { region });
    if (result?.status !== "success") {
      select.value = previous || "global";
      return;
    }
    state.awaitingCode = false;
    const account = $("account-input");
    const password = $("password-input");
    const code = $("code-input");
    if (account) account.value = "";
    if (password) password.value = "";
    if (code) code.value = "";
    renderLoginMode();
  }

  async function setPrinter() {
    const select = $("printer-select");
    if (!select) return;
    const printerId = select.value;
    const previous = state.status?.config?.printerId || "";
    if (printerId === previous) return;
    const result = await runAction("setPrinter", { printerId });
    if (result?.status !== "success") {
      select.value = previous;
      return;
    }
    // 连接状态在后台异步变化，稍后再读一次。
    setTimeout(() => loadStatus({ silent: true }), 1_500);
  }

  // ---------------------------------------------------------------------
  // 诊断
  // ---------------------------------------------------------------------

  function diagnosticExport() {
    const status = state.status || {};
    const printer = status.printer || {};
    const report = printer.state || {};
    const link = printer.link || {};
    const oneOf = (value, allowed) => allowed.includes(value) ? value : null;
    const number = (value) => Number.isFinite(value) ? value : null;
    const sensor = (value) => ({ current: number(value?.current), target: number(value?.target) });
    const requests = Array.isArray(state.diagnostics?.requests) ? state.diagnostics.requests : [];
    return {
      generatedAt: new Date().toISOString(),
      status: {
        authState: oneOf(status.auth?.state, ["signed-in", "signed-out", "expired"]),
        region: oneOf(status.config?.region, ["global", "china"]),
        credentialStoreAvailable: status.credentialStore?.available === true,
        deviceCount: Array.isArray(status.devices) ? status.devices.length : null,
        link: {
          state: oneOf(link.state, ["idle", "connecting", "connected", "reconnecting", "failed"]),
          attempt: number(link.attempt),
          subscribed: link.subscribed === true,
        },
        printerState: {
          activity: oneOf(report.activity, ["idle", "preparing", "printing", "paused", "finished", "failed", "unknown"]),
          lastReportAt: number(report.lastReportAt),
          progressPercent: number(report.progressPercent),
          remainingMinutes: number(report.remainingMinutes),
          nozzle: sensor(report.nozzle),
          bed: sensor(report.bed),
        },
      },
      diagnostics: {
        // 路径、日志和错误文本可能包含任意标识，不纳入导出。
        requests: requests.map((request) => ({
          at: number(request.at),
          method: oneOf(request.method, ["GET", "POST", "PUT", "DELETE", "PATCH"]),
          status: number(request.status),
          kind: oneOf(request.kind, [
            "invalid-credentials", "verification-required", "verification-invalid", "invalid-phone",
            "two-factor-required", "rate-limited", "network", "timeout", "region-mismatch",
            "unauthorized", "device-list-unavailable", "unknown",
          ]),
          durationMs: number(request.durationMs),
        })),
      },
    };
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(diagnosticExport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      showMessage("诊断信息已复制（已隐去用户、设备和任务标识）", "success");
      return;
    } catch {
      // 回退到隐藏 textarea + execCommand。
    }

    const fallback = $("copy-fallback");
    if (!fallback) {
      showMessage("无法复制诊断信息，请展开已隐去标识的状态快照手动复制。", "error");
      return;
    }
    fallback.hidden = false;
    fallback.value = text;
    fallback.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    fallback.hidden = true;
    showMessage(copied ? "诊断信息已复制（已隐去用户、设备和任务标识）" : "无法复制诊断信息，请展开已隐去标识的状态快照手动复制。", copied ? "success" : "error");
  }

  // ---------------------------------------------------------------------
  // 格式化
  // ---------------------------------------------------------------------

  function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    try {
      return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
    } catch {
      return "—";
    }
  }

  function formatDateTime(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    try {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return "—";
    }
  }

  function formatAge(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return "—";
    if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
    return `${(durationMs / 1000).toFixed(1)} s`;
  }

  function formatPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return `${Math.round(value)}%`;
  }

  function formatMinutes(minutes) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return "—";
    if (minutes < 60) return `${Math.round(minutes)} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
  }

  function withFreshness(value, freshness) {
    if (!freshness || !Number.isFinite(freshness.at) || freshness.at > Date.now()) return `${value}（更新时间未知）`;
    if (freshness.stale === true || Date.now() - freshness.at > 5 * 60 * 1000) return `${value}（旧数据）`;
    if (freshness.stale !== false) return `${value}（更新时间未知）`;
    return String(value);
  }

  function formatTemperature(sensor, currentFreshness, targetFreshness) {
    const current = typeof sensor?.current === "number" && Number.isFinite(sensor.current) ? `${Math.round(sensor.current)}℃` : "—";
    const formatted = withFreshness(current, currentFreshness);
    if (typeof sensor?.target !== "number" || !Number.isFinite(sensor.target)) return formatted;
    return `${formatted} → ${withFreshness(`${Math.round(sensor.target)}℃`, targetFreshness)}`;
  }

  function labelForActivity(activity, rawActivity) {
    const labels = {
      idle: "空闲",
      preparing: "准备中",
      printing: "打印中",
      paused: "已暂停",
      finished: "打印完成",
      failed: "打印异常",
      unknown: "未知",
    };
    if (activity && activity !== "unknown" && Object.hasOwn(labels, activity)) return labels[activity];
    return rawActivity ? `未知（原始值 ${rawActivity}）` : activity && activity !== "unknown" ? `未知（原始值 ${activity}）` : "未知";
  }

  function labelForLink(linkState, link) {
    if (linkState === "connected") return "云端连接正常";
    if (linkState === "connecting") return "正在连接云端";
    if (linkState === "reconnecting") return `连接中断，正在重连${link?.attempt ? `（第 ${link.attempt} 次）` : ""}`;
    if (linkState === "failed") return link?.lastError?.message || "云端连接失败";
    return "未连接";
  }

  function labelForRegion(regionId, regions) {
    const items = Array.isArray(regions) ? regions : [];
    const found = items.find((item) => item.id === regionId);
    if (found) return found.label;
    if (regionId === "global") return "全球";
    if (regionId === "china") return "中国大陆";
    return "区域未知";
  }

  // ---------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------

  function showApp() {
    setHidden("token-missing", true);
    setHidden("app", false);
  }

  function showTokenScreen(message) {
    stopPolling();
    state.generation += 1;
    state.token = "";
    clearStoredToken();
    setHidden("app", true);
    setHidden("token-missing", false);
    const node = $("token-message");
    if (node && message) node.textContent = message;
  }

  function bindEvents() {
    $("manual-token-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("manual-token");
      const token = extractToken(input ? input.value : "");
      if (!token) {
        const node = $("token-message");
        if (node) node.textContent = "没有识别到有效令牌，请重新粘贴。";
        return;
      }
      state.generation += 1;
      state.statusFailures = 0;
      state.lastStatusAt = null;
      state.serviceUnavailable = false;
      setHidden("service-warning", true);
      state.token = token;
      persistToken(token);
      stripTokenFromAddress();
      if (input) input.value = "";
      showApp();
      loadStatus();
      loadDiagnostics();
      startPolling();
    });

    $("login-form").addEventListener("submit", submitLogin);
    $("send-code-btn").addEventListener("click", sendCode);
    $("switch-password-btn").addEventListener("click", async () => {
      const result = await runAction("cancelCode");
      if (result?.status === "success") $("password-input")?.focus();
    });
    $("logout-btn").addEventListener("click", logout);
    $("region-select").addEventListener("change", setRegion);
    $("printer-select").addEventListener("change", setPrinter);

    $("refresh-btn").addEventListener("click", () => {
      loadStatus();
      loadDiagnostics({ silent: true });
    });
    $("refresh-devices-btn").addEventListener("click", () => runAction("refreshDevices"));
    $("test-connection-btn").addEventListener("click", () => runAction("testConnection"));
    $("full-state-btn").addEventListener("click", () => runAction("requestFullState"));
    $("refresh-diag-btn").addEventListener("click", () => loadDiagnostics());
    $("copy-diag-btn").addEventListener("click", copyDiagnostics);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.token) {
        loadStatus({ silent: true });
        loadDiagnostics({ silent: true });
      }
    });
  }

  function init() {
    bindEvents();
    const token = readHashToken() || storedToken();
    if (!token) {
      showTokenScreen();
      return;
    }
    state.token = token;
    persistToken(token);
    stripTokenFromAddress();
    showApp();
    loadStatus();
    loadDiagnostics();
    startPolling();
  }

  init();
})();

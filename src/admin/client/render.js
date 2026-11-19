/**
 * 浏览器后台的 DOM 渲染。
 *
 * 只负责把 view-model 产出的展示值写入页面节点；不读取令牌、不发请求。
 * 所有文本都通过 textContent 写入，避免把设备上报内容当 HTML 解释。
 */

function createRenderer({ document: documentRef, getState, model, format }) {
  const { formatTime, formatDateTime, formatAge, formatDuration, formatPercent, formatMinutes } = format;
  const {
    createObservationContext,
    withFreshness,
    formatTemperature,
    labelForPresence,
    labelForActivity,
    labelForLink,
    labelForRegion,
    formatErrorChannel,
    deviceSuffix,
  } = model;

  let observationContext = null;

  function $(id) {
    return documentRef.getElementById(id);
  }

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
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
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
      setText("banner", "");
      setHidden("banner", true);
      return;
    }
    setText("banner", messages.join("；"));
    setHidden("banner", false);
    const node = $("banner");
    if (node) node.className = `banner ${level}`;
  }

  function renderRegionSelect(regions, current, signedIn) {
    const select = $("region-select");
    if (!select) return;
    const fallback = [
      { id: "global", label: "全球" },
      { id: "china", label: "中国大陆" },
    ];
    const items = Array.isArray(regions) && regions.length ? regions : fallback;
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
    select.disabled = Boolean(getState().busy) || signedIn || getState().awaitingCode;
    setText("region-hint", signedIn
      ? "退出登录后才能切换区域。"
      : current === "china"
        ? "中国大陆账号只能使用手机号登录，验证码通过短信发送。"
        : "全球账号使用邮箱登录，验证码通过邮件发送；区域选错会登录失败。");
    renderAccountField(current || "global");
  }

  function renderLoginMode(region) {
    const awaiting = getState().awaitingCode;
    const channel = region === "china" ? "短信" : "邮箱";
    setHidden("password-field", awaiting);
    setHidden("code-field", !awaiting);
    setText("code-label", `${channel}验证码`);
    setText("code-hint", `验证码会发送到账号${channel === "短信" ? "手机" : "邮箱"}。若没有收到，可以重新发送。`);
    setText("login-btn", awaiting ? "提交验证码" : "登录");
    setText("send-code-btn", awaiting ? `重新发送${channel}验证码` : `发送${channel}验证码`);
    setHidden("switch-password-btn", !awaiting);
    // 验证码模式下账号与区域必须锁定，避免切换账号后继续用旧验证码。
    setBusy(getState().busy);
  }

  function renderAms(ams, freshness, capabilities = {}) {
    const list = $("ams-list");
    clear(list);
    const units = Array.isArray(ams?.units) ? ams.units : null;
    setHidden("ams-section", !units?.length);
    setText("ams-empty", units === null ? (ams && Object.hasOwn(ams, "units") ? "AMS 列表未知" : "尚无 AMS 数据") : units.length ? "" : "已上报空 AMS 列表");
    if (!list || !ams) return;
    const now = Date.now();
    if (ams.rawStatus !== null && ams.rawStatus !== undefined) {
      list.appendChild(create("li", "status-item", `AMS 状态原始值：${withFreshness(ams.rawStatus, freshness?.fields?.rawStatus, observationContext, now)}`));
    }
    if (ams.rawTrayNow !== null && ams.rawTrayNow !== undefined && (!ams.current || !units)) {
      list.appendChild(create("li", "status-item", `当前耗材原始值：${withFreshness(ams.rawTrayNow, freshness?.fields?.rawTrayNow, observationContext, now)}`));
    }
    for (const unit of units || []) {
      if (!unit || typeof unit !== "object") continue;
      const capability = capabilities[unit.id] || {};
      const unitLabel = capability.type && capability.type !== "unknown"
        ? `${capability.label} ${unit.id ?? "未知"}` : `AMS ${unit.id ?? "未知"}（类型未知）`;
      // AMS 3H 按分区上报，不能把分区读数合并成一个整箱温湿度。
      for (const zone of Array.isArray(unit.zones) ? unit.zones : []) {
        if (!zone || typeof zone !== "object") continue;
        const supported = capability.zones?.[zone.id] || {};
        const marks = freshness?.units?.[unit.id]?.zones?.[zone.id] || {};
        const values = [];
        if (supported.temperature === true && Number.isFinite(zone.temperature)) {
          values.push(`温度：${withFreshness(`${Math.round(zone.temperature)}℃`, marks.temperature, observationContext, now)}`);
        }
        if (supported.humidity === true && Number.isFinite(zone.humidity)) {
          values.push(`湿度：${withFreshness(`${zone.humidity}%`, marks.humidity, observationContext, now)}`);
        }
        if (supported.dryingMinutes === true && Number.isFinite(zone.dryingMinutes)) {
          values.push(`烘干剩余：${withFreshness(formatMinutes(zone.dryingMinutes), marks.dryingMinutes, observationContext, now)}`);
        }
        if (values.length) list.appendChild(create("li", "status-item", `${unitLabel} · 分区 ${Number(zone.id) + 1} · ${values.join(" · ")}`));
      }
      const slots = Array.isArray(unit.slots) ? unit.slots : null;
      if (!slots) {
        list.appendChild(create("li", "status-item", `${unitLabel}：暂无槽位数据，槽位信息未知`));
        continue;
      }
      if (!slots.length) list.appendChild(create("li", "status-item", `${unitLabel}：已上报空槽位列表`));
      for (const slot of slots) {
        if (!slot || typeof slot !== "object") continue;
        const item = create("li", "status-item");
        const exists = slot.exists === true ? "存在" : slot.exists === false ? "空槽" : "未知";
        const label = `${unitLabel} · 槽位 ${slot.id ?? "未知"}`;
        const slotFreshness = freshness?.units?.[unit.id]?.slots?.[slot.id] || {};
        // 仅凭仍然新鲜的空槽观察隐藏旧耗材；过期或未知观察不应遮住新报告的字段。
        const observedAt = slotFreshness.exists?.at;
        const confirmedEmpty = slot.exists === false && slotFreshness.exists?.stale === false &&
          Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= 5 * 60 * 1000;
        if (confirmedEmpty) {
          item.appendChild(create("span", "", `${label} · 耗材：${withFreshness(exists, slotFreshness.exists, observationContext, now)}`));
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
        const currentLabel = active ? `（${withFreshness("当前", freshness?.fields?.current, observationContext, now)}）` : "";
        item.appendChild(create("span", "", `${label}${currentLabel} · 耗材：${withFreshness(exists, slotFreshness.exists, observationContext, now)} · 材质：${withFreshness(slot.material || "未知", slotFreshness.material, observationContext, now)} · 颜色：${withFreshness(color ? `#${color}` : "未知", slotFreshness.color, observationContext, now)}${capability.remaining === true ? ` · 余量：${withFreshness(remaining, slotFreshness.remaining, observationContext, now)}` : ""} · 状态原始值：${withFreshness(rawState, slotFreshness.rawState, observationContext, now)}`));
        list.appendChild(item);
      }
    }
  }

  function renderHms(hms, freshness) {
    const list = $("hms-list");
    clear(list);
    const now = Date.now();
    const entries = Array.isArray(hms) ? hms.filter((item) => item && typeof item === "object") : null;
    setText("hms-empty", entries === null ? "故障信息未知" : entries.length ? "" : withFreshness("当前无已上报的 HMS 故障", freshness, observationContext, now));
    if (!list || !entries) return;
    for (const entry of entries) {
      const fields = [["代码", entry.code], ["属性", entry.attr], ["模块", entry.module]]
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([label, value]) => `${label}：${value}`);
      list.appendChild(create("li", "status-item", withFreshness(fields.length ? fields.join(" · ") : "故障详情未知", freshness, observationContext, now)));
    }
  }

  function renderDevices(data, signedIn) {
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const selected = data.config?.printerId || "";
    const hasSelection = Boolean(selected);
    const showPanel = signedIn && (devices.length > 0 || hasSelection);
    const now = Date.now();

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
        const model = device.model ? ` · ${device.model}` : "";
        const option = create("option", "", `${device.name || device.id}${model}${deviceSuffix(device.online)}`);
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
    select.disabled = Boolean(getState().busy);

    const count = devices.length;
    setText("device-hint", data.monitorBlockMessage || (data.devicesError
      ? data.devicesError
      : count
        ? `共 ${count} 台设备，列表在线状态为${data.devicesFetchedAt != null ? formatDateTime(data.devicesFetchedAt) : "最近读取时"}的快照；实际连接见下方。`
        : "设备列表暂不可用，但仍显示当前选择的打印机。"));

    const printer = data.printer || {};
    const link = printer.link || {};
    const linkState = link.state || "idle";
    setText("link-state", labelForLink(linkState, link));
    const linkNode = $("link-state");
    if (linkNode) linkNode.className = `link-${linkState}`;

    const printerState = printer.state || {};
    setText("last-report", printerState.lastReportAt
      ? `${formatTime(printerState.lastReportAt)}（${formatAge(printerState.lastReportAt, now)}）`
      : "尚未收到");
    const freshness = printerState.freshness || {};
    const fields = freshness.fields || {};
    const presence = observationContext?.presence;
    const presenceLabel = labelForPresence(presence, linkState, now);
    setText("printer-presence", presenceLabel);
    setText("last-message", presence?.lastMessageAt != null ? formatDateTime(presence.lastMessageAt) : "尚未收到");
    setText("last-telemetry", presence?.lastTelemetryAt != null ? formatDateTime(presence.lastTelemetryAt) : "尚未收到");
    setText("activity", presence && (linkState !== "connected" || !model.telemetryActive(presence, now)) ? presenceLabel
      : withFreshness(labelForActivity(printerState.activity, printerState.rawActivity), fields.activity, observationContext, now));
    setText("task-name", withFreshness(printerState.taskName || "—", fields.taskName, observationContext, now));
    setText("layer-text", `${withFreshness(Number.isFinite(printerState.layerNum) && printerState.layerNum >= 0 ? printerState.layerNum : "未知", fields.layerNum, observationContext, now)} / ${withFreshness(Number.isFinite(printerState.totalLayerNum) && printerState.totalLayerNum >= 0 ? printerState.totalLayerNum : "未知", fields.totalLayerNum, observationContext, now)}`);
    setText("progress-text", withFreshness(formatPercent(printerState.progressPercent), fields.progressPercent, observationContext, now));
    setText("remaining-text", withFreshness(formatMinutes(printerState.remainingMinutes), fields.remainingMinutes, observationContext, now));
    setText("nozzle-text", formatTemperature(printerState.nozzle, fields["nozzle.current"], fields["nozzle.target"], observationContext, now));
    setText("bed-text", formatTemperature(printerState.bed, fields["bed.current"], fields["bed.target"], observationContext, now));
    setText("error-code", `print_error：${formatErrorChannel(printerState.printError, fields.printError, observationContext, now)} · mc_print_error_code：${formatErrorChannel(printerState.printErrorCode, fields.printErrorCode, observationContext, now)}`);
    const hasReport = Number.isFinite(printerState.lastReportAt);
    setText("report-freshness", presence
      ? `${presenceLabel}。${model.telemetryActive(presence, now) && linkState === "connected" ? "增量未重复的字段沿用最近观测；字段时间不代表重新测量。" : "显示最后观测值，等待有效设备遥测。"}${presence.autoAttempts ? ` 已尝试自动恢复 ${presence.autoAttempts} 次。` : ""}`
      : !hasReport
      ? "尚未收到设备状态，无法判断当前状态。"
      : linkState !== "connected" || printerState.reportStale === true
        ? "设备状态可能是断连前的旧数据，等待新的设备报文。"
        : now - printerState.lastReportAt > 5 * 60 * 1000
          ? "超过 5 分钟未收到设备报文；部分字段可能保留更早的数据。"
          : "最近报文时间不代表所有字段的更新时间；部分字段可能保留较早的数据。");
    renderHms(printerState.hms, fields.hms);
    renderAms(printerState.ams, freshness.ams, printer.capabilities?.ams);

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

  function renderInstrumentCards(data) {
    const available = data.auth?.state === "signed-in" && Boolean(data.config?.printerId);
    const report = available ? data.printer?.state || {} : {};
    const fields = report.freshness?.fields || {};
    const sensors = available ? data.printer?.capabilities?.sensors || {} : {};
    const now = Date.now();
    for (const key of ["nozzle", "bed", "chamber"]) setHidden(`sensor-${key}`, sensors[key] !== true);
    for (const [key, capability] of Object.entries({ part: "fanPart", auxiliary: "fanAuxiliary", chamber: "fanChamber", heatbreak: "fanHeatbreak" })) {
      setHidden(`sensor-fan-${key}`, sensors[capability] !== true);
    }
    setHidden("temperature-card", !["nozzle", "bed", "chamber"].some(key => sensors[key] === true));
    setHidden("fan-card", !["fanPart", "fanAuxiliary", "fanChamber", "fanHeatbreak"].some(key => sensors[key] === true));
    setText("hero-task", report.taskName ? withFreshness(report.taskName, fields.taskName, observationContext, now) : "等待打印任务");
    setText("hero-progress", withFreshness(formatPercent(report.progressPercent), fields.progressPercent, observationContext, now));
    setText("hero-state", observationContext && (observationContext.link !== "connected" || !model.telemetryActive(observationContext.presence, now))
      ? labelForPresence(observationContext.presence, observationContext.link, now)
      : withFreshness(labelForActivity(report.activity, report.rawActivity), fields.activity, observationContext, now));
    const chamber = report.chamber?.current;
    setText("chamber-text", Number.isFinite(chamber)
      ? withFreshness(`${Math.round(chamber)}℃`, fields["chamber.current"], observationContext, now)
      : "未知");
    for (const key of ["part", "auxiliary", "chamber", "heatbreak"]) {
      const value = report.fans?.[key];
      const text = Number.isFinite(value) && value >= 0 && value <= 100 ? `${Math.round(value)}%` : "未知";
      setText(`fan-${key}`, value == null ? text : withFreshness(text, fields[`fans.${key}`], observationContext, now));
    }
  }

  const TAB_NAMES = ["overview", "account", "diagnostics", "debug"];

  function selectTab(name) {
    if (!TAB_NAMES.includes(name)) return;
    getState().activeTab = name;
    for (const key of TAB_NAMES) {
      setHidden(`panel-${key}`, key !== name);
      const tab = $(`tab-${key}`);
      if (tab) {
        tab.setAttribute("aria-selected", String(key === name));
        tab.tabIndex = key === name ? 0 : -1;
      }
    }
    if (name === "debug") renderDebugFrames();
  }

  function renderDebugFrames() {
    const state = getState();
    const list = $("debug-frames");
    if (!list || state.activeTab !== "debug") return;
    const protocol = $("debug-protocol")?.value || "all";
    const query = ($("debug-search")?.value || "").trim().toLowerCase();
    const frames = state.debugFrames.filter(frame => (protocol === "all" || frame.protocol === protocol) &&
      (!query || JSON.stringify(frame).toLowerCase().includes(query)));
    const signature = JSON.stringify([frames, protocol, query]);
    setText("debug-count", `${state.debugPaused ? "显示已暂停 · " : ""}${frames.length} / ${state.debugFrames.length} 条记录`);
    setHidden("debug-empty", frames.length > 0);
    setText("debug-empty", state.debugFrames.length ? "没有匹配的记录。" : "尚未收到数据，请登录并连接设备，或刷新设备列表。");
    if (signature === state.debugSignature) return;
    state.debugSignature = signature;
    const opened = new Set(Array.from(list.children).filter(node => node.open).map(node => node.dataset.id));
    clear(list);
    for (const frame of frames) {
      const item = create("details", "debug-frame");
      item.dataset.id = String(frame.id);
      item.open = opened.has(String(frame.id));
      const summary = create("summary");
      summary.appendChild(create("span", "", formatDateTime(frame.at)));
      summary.appendChild(create("span", "badge", String(frame.protocol || "unknown").toUpperCase()));
      summary.appendChild(create("span", "", `${frame.source || "—"}${frame.truncated ? " · 数据已截断" : ""}`));
      item.appendChild(summary);
      item.appendChild(create("pre", "", JSON.stringify(frame, null, 2)));
      list.appendChild(item);
    }
  }

  function renderRequests(data) {
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

  function renderDiagnostics(data) {
    const state = getState();
    if (!state.debugPaused) state.debugFrames = Array.isArray(data.frames) ? data.frames : [];
    renderDebugFrames();
    renderRequests(data);
  }

  function renderSnapshot(data, snapshotText) {
    const node = $("snapshot");
    if (node && node.textContent !== snapshotText) node.textContent = snapshotText;
    void data;
  }

  function renderStatus(data, { onFirstPayload } = {}) {
    observationContext = createObservationContext(data);
    const state = getState();
    const auth = data.auth || {};
    const config = data.config || {};
    const signedIn = auth.state === "signed-in";
    const expired = auth.state === "expired";

    setText("auth-pill", signedIn ? "已登录" : expired ? "登录已失效" : "未登录");
    const pill = $("auth-pill");
    if (pill) pill.className = `pill ${signedIn ? "signed-in" : expired ? "expired" : "muted"}`;

    setText("region-badge", labelForRegion(config.region, data.regions));
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
    renderInstrumentCards(data);
    if (!signedIn && !state.initialTabSelected) selectTab("account");
    state.initialTabSelected = true;
    renderLoginMode(config.region);
    setBusy(state.busy);
    setText("admin-port", data.admin?.port ? `本地端口 ${data.admin.port}` : "");
    if (onFirstPayload) onFirstPayload(data);
  }

  function setBusy(busy) {
    const state = getState();
    state.busy = Boolean(busy);
    const ids = [
      "refresh-btn", "login-btn", "send-code-btn", "switch-password-btn", "logout-btn",
      "refresh-devices-btn", "test-connection-btn", "full-state-btn", "refresh-diag-btn",
    ];
    for (const id of ids) {
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

  function showServiceWarning(text) {
    setText("service-warning", text);
    setHidden("service-warning", !text);
  }

  function showApp() {
    setHidden("token-missing", true);
    setHidden("app", false);
  }

  function showTokenScreen(message, onHide) {
    setHidden("app", true);
    setHidden("token-missing", false);
    const node = $("token-message");
    if (node && message) node.textContent = message;
    if (onHide) onHide();
  }

  return {
    setText,
    setHidden,
    showMessage,
    showBanner,
    showServiceWarning,
    showApp,
    showTokenScreen,
    setBusy,
    selectTab,
    renderStatus,
    renderDiagnostics,
    renderSnapshot,
    renderDebugFrames,
    renderLoginMode,
    renderRegionSelect,
    renderAccountField,
    TAB_NAMES,
    get observationContext() { return observationContext; },
  };
}

module.exports = {
  createRenderer,
};

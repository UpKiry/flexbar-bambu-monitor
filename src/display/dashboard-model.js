const { buildDisplay, presenceDisplay } = require('./presenter');
const { getPrinterCapabilities } = require('../printer/capabilities');

const number = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => number(value) && value >= 0 && value <= 100;
const text = value => typeof value === 'string' && value.trim().length > 0;
const code = value => number(value) || text(value);
const nonzero = value => code(value) && !/^0+$/.test(String(value));

/** 仅构造绘制数据，不改写领域状态。fresh / markFresh 与 dashboard 兼容入口共用。 */
function buildDashboardUi(input, { fresh, markFresh, activityLabel, activityKey }) {
  const { state = {}, link, now, printerName, model, signedIn, hasPrinter, authExpired } = input;
  const reading = (value, key, valid = number, format = String) => {
    const exists = valid(value);
    return { text: exists ? format(value) : '—', stale: exists && !fresh(key) };
  };
  const display = buildDisplay({ ...input, state });
  const precondition = !signedIn || !hasPrinter;
  const status = presenceDisplay(state.presence, link, now);
  const connection = !signedIn ? authExpired ? '登录已失效' : '请登录'
    : !hasPrinter ? '请选择打印机'
      : status ? status.title.replace('打印机', '设备').replace('云端连接中断', '云端断开')
        : state.presence ? '设备在线'
          : ({ connected: '云端已连接', connecting: '云端连接中', reconnecting: '云端重连中', failed: '云端断开', idle: '云端未连接' }[link?.state] || '状态未知');
  const capabilities = getPrinterCapabilities(model, state);
  const sensor = key => ({
    current: reading(state[key]?.current, `${key}.current`, number, v => String(Math.round(v))),
    target: reading(state[key]?.target, `${key}.target`, number, v => String(Math.round(v))),
  });
  const allSlots = (state.ams?.units || []).flatMap(unit => (unit?.slots || []).filter(slot => slot && typeof slot === 'object').map(slot => {
    const marks = state.freshness?.ams?.units?.[unit.id]?.slots?.[slot.id];
    const r = (key, valid, format = String) => ({
      text: valid(slot[key]) ? format(slot[key]) : '—',
      stale: valid(slot[key]) && !markFresh(marks?.[key]),
    });
    const empty = slot.exists === false;
    return {
      unitId: unit.id, id: slot.id,
      exists: r('exists', v => typeof v === 'boolean', v => v ? '有' : '空'),
      material: empty ? { text: '空', stale: !markFresh(marks?.exists) } : r('material', text, v => v.trim()),
      color: empty ? { text: '—', stale: false } : r('color', v => typeof v === 'string' && /^[0-9a-f]{8}$/i.test(v), v => `#${v.slice(0, 6)}`),
      remaining: !empty && capabilities.ams[unit.id]?.remaining ? r('remaining', percent, v => `${Math.round(v)}%`) : { text: '—', stale: false },
    };
  }));
  const faults = [
    nonzero(state.printError) ? reading(state.printError, 'printError', code, v => `错误 ${v}`) : null,
    nonzero(state.printErrorCode) ? reading(state.printErrorCode, 'printErrorCode', code, v => `代码 ${v}`) : null,
    Array.isArray(state.hms) && state.hms.length ? reading(state.hms, 'hms', Array.isArray, entries => `HMS ${entries.map(entry => [entry?.code, entry?.attr, entry?.module].filter(code).join('/') || '详情未知').join(', ')}`) : null,
  ].filter(Boolean);
  const freshFault = faults.some(fault => !fault.stale);
  const faultReports = [['printError', state.printError], ['printErrorCode', state.printErrorCode]]
    .filter(([, value]) => code(value)).map(([key]) => key);
  if (Array.isArray(state.hms)) faultReports.push('hms');
  const fault = faults.length ? { text: faults.map(v => `${v.text}${v.stale ? '（旧）' : ''}`).join(' · '), stale: faults.every(v => v.stale) }
    : state.activity === 'failed' ? { text: '设备报告打印失败 · 无原始错误码', stale: !fresh('activity') }
      : { text: faultReports.length ? '无已报告故障' : '故障信息未知', stale: faultReports.some(key => !fresh(key)) };
  const firstUnit = state.ams?.units?.[0];
  const time = number(state.lastReportAt) && Math.abs(state.lastReportAt) <= 8640000000000000
    ? new Date(state.lastReportAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  const progress = reading(state.progressPercent, 'progressPercent', percent, v => String(Math.round(v)));
  return {
    tone: precondition ? 'muted' : freshFault ? 'critical' : display.tone,
    feedback: text(input.feedback?.text) ? { text: input.feedback.text, level: input.feedback.level } : null,
    connection, title: precondition ? display.title : (text(printerName) ? printerName.trim() : capabilities.model || '打印机'),
    subtitle: precondition ? display.subtitle : status?.subtitle || display.subtitle,
    precondition,
    activity: reading(activityLabel, activityKey, v => text(v) && v !== '—'),
    task: reading(state.taskName, 'taskName', text, v => v.trim()),
    progress: { ...progress, value: percent(state.progressPercent) ? state.progressPercent : null },
    remaining: reading(state.remainingMinutes, 'remainingMinutes', v => number(v) && v >= 0, v => {
      const minutes = Math.round(v);
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    }),
    layer: reading(state.layerNum, 'layerNum', v => number(v) && v >= 0),
    totalLayer: reading(state.totalLayerNum, 'totalLayerNum', v => number(v) && v >= 0),
    nozzle: sensor('nozzle'), bed: sensor('bed'),
    fans: [ ['part', '部件', 'fanPart'], ['heatbreak', '热端', 'fanHeatbreak'], ['auxiliary', '辅助', 'fanAuxiliary'], ['chamber', '排风', 'fanChamber'] ]
      .filter(([, , capability]) => capabilities.sensors[capability])
      .map(([key, label]) => ({ label, value: reading(state.fans?.[key], `fans.${key}`, percent, v => `${Math.round(v)}%`) })),
    slots: allSlots.slice(0, 4), extraSlots: Math.max(0, allSlots.length - 4),
    amsLabel: firstUnit ? `${capabilities.ams[firstUnit.id]?.label || 'AMS'} · ${firstUnit.id}` : 'AMS',
    updated: { text: time, stale: Boolean(status) || link?.state !== 'connected' || state.reportStale === true },
    fault, urgent: !precondition && (faults.length > 0 || (state.activity === 'failed' && fresh('activity'))),
  };
}

module.exports = { buildDashboardUi };

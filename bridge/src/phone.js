/**
 * 手机通道（2026-10-17）：让她能"看见"和"操作"一台安卓设备。
 *
 * **只连专用设备**（MuMu 模拟器 / 备用机）—— 管理员明确说过这台就是给她用的，
 * 不是主力机。所以这里的每个操作都必须**限定在一台显式配置的设备**上，
 * 不许"连上什么就操作什么"（那台机器上如果恰好有别的 adb 设备，会误伤）。
 *
 * 纯逻辑都在这儿（便于离线测），真正起进程的封装在桥接里。
 */

/** 按键名 → adb keyevent 码。只暴露这几个，够用且不会"乱按"。 */
export const KEYS = {
  home: 3,
  back: 4,
  recent: 187,
  enter: 66,
  delete: 67,
  tab: 61,
  space: 62,
  escape: 111,
  volup: 24,
  voldown: 25,
  power: 26,
  playpause: 85,
};

/**
 * 动作的"白名单 + 形状校验"。
 * 为什么要有白名单：这些参数的最终去向是 `adb shell input …`，
 * **只要拼进命令行就有注入风险**（比如 x 传 `1; rm -rf /`）——
 * 所以每个字段都必须是纯数字/已知枚举，不接受任何自由文本。
 */
export function normalizeAction(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const kind = String(a.kind ?? a.type ?? '').trim().toLowerCase();
  const num = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n);
    if (r < min || r > max) return null;
    return r;
  };
  switch (kind) {
    case 'tap': {
      const x = num(a.x, 0, 20000);
      const y = num(a.y, 0, 20000);
      if (x === null || y === null) return { ok: false, error: 'tap 需要数值 x / y' };
      return { ok: true, action: { kind: 'tap', x, y } };
    }
    case 'longpress': {
      const x = num(a.x, 0, 20000);
      const y = num(a.y, 0, 20000);
      const ms = num(a.ms ?? 800, 100, 10000) ?? 800;
      if (x === null || y === null) return { ok: false, error: 'longpress 需要数值 x / y' };
      // 长按 = 原地 swipe 停留
      return { ok: true, action: { kind: 'swipe', x1: x, y1: y, x2: x, y2: y, ms } };
    }
    case 'swipe': {
      const x1 = num(a.x1, 0, 20000); const y1 = num(a.y1, 0, 20000);
      const x2 = num(a.x2, 0, 20000); const y2 = num(a.y2, 0, 20000);
      const ms = num(a.ms ?? 300, 30, 10000) ?? 300;
      if ([x1, y1, x2, y2].some((v) => v === null)) return { ok: false, error: 'swipe 需要数值 x1/y1/x2/y2' };
      return { ok: true, action: { kind: 'swipe', x1, y1, x2, y2, ms } };
    }
    case 'key': {
      const name = String(a.key ?? a.name ?? '').trim().toLowerCase();
      const code = KEYS[name];
      if (!code) return { ok: false, error: `不认的按键：${name || '(空)'}（可用：${Object.keys(KEYS).join('/')}）` };
      return { ok: true, action: { kind: 'key', key: name, code } };
    }
    case 'text': {
      const text = String(a.text ?? '');
      if (!text.trim()) return { ok: false, error: 'text 不能为空' };
      if (text.length > 500) return { ok: false, error: 'text 太长（≤500 字）' };
      return { ok: true, action: { kind: 'text', text } };
    }
    case 'shot': return { ok: true, action: { kind: 'shot' } };
    case 'wait': {
      const ms = num(a.ms ?? 1000, 100, 30000) ?? 1000;
      return { ok: true, action: { kind: 'wait', ms } };
    }
    default:
      return { ok: false, error: `不认的动作：${kind || '(空)'}（可用：tap/longpress/swipe/key/text/shot/wait）` };
  }
}

/** 把动作翻译成 adb 参数（不含 adb 本体和 -s 设备）。 */
export function actionToArgs(action) {
  switch (action?.kind) {
    case 'tap': return ['shell', 'input', 'tap', String(action.x), String(action.y)];
    case 'swipe': return ['shell', 'input', 'swipe', String(action.x1), String(action.y1), String(action.x2), String(action.y2), String(action.ms)];
    case 'key': return ['shell', 'input', 'keyevent', String(action.code)];
    // text 走 `input text`：空格要转义成 %s，其余字符靠 adb 自己处理。
    // 中文靠 ADBKeyboard（IME 方式），见桥接里的 `inputText`。
    case 'text': return ['shell', 'input', 'text', String(action.text).replace(/ /g, '%s')];
    case 'shot': return ['exec-out', 'screencap', '-p'];
    case 'wait': return [];
    default: return [];
  }
}

/** ── 连招（combo）────────────────────────────────────────────── */

export function cleanComboName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .slice(0, 40);
}

/**
 * 校验一条连招：必须是动作数组，长度有上限。
 * 上限 60 步是有意的 —— 连招是"一次批准跑一段"，太长就成了"授权她不限次数操作"。
 */
export function normalizeCombo(steps, { maxSteps = 60 } = {}) {
  if (!Array.isArray(steps) || !steps.length) return { ok: false, error: '连招至少要一步' };
  if (steps.length > maxSteps) return { ok: false, error: `连招最多 ${maxSteps} 步（现在 ${steps.length}）` };
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const r = normalizeAction(steps[i]);
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 步：${r.error}` };
    if (r.action.kind === 'shot') return { ok: false, error: `第 ${i + 1} 步：连招里不放截屏（截图单独要）` };
    out.push(r.action);
  }
  return { ok: true, steps: out };
}

/** 连招的"危险度"评估：给管理员看的，不影响执行。 */
export function comboRisk(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const taps = list.filter((s) => s?.kind === 'tap').length;
  const texts = list.filter((s) => s?.kind === 'text').length;
  const keys = list.filter((s) => s?.kind === 'key').map((s) => s.key);
  return {
    steps: list.length,
    taps, texts,
    keys: [...new Set(keys)],
    // 有打字 = 可能在输入框里写字（包括发给别人）；有 power 键 = 会锁屏亮屏
    risky: texts > 0 || keys.includes('power'),
  };
}

/** 解析落盘的连招库（宽容：坏数据当空）。 */
export function parseComboStore(text) {
  try {
    const o = JSON.parse(String(text ?? '') || '{}');
    const combos = {};
    for (const [name, v] of Object.entries(o?.combos ?? {})) {
      const n = normalizeCombo(v?.steps);
      if (!n.ok) continue;
      combos[name] = { steps: n.steps, at: Number(v?.at) || 0, runs: Number(v?.runs) || 0 };
    }
    return { combos };
  } catch {
    return { combos: {} };
  }
}

export function trimComboStore(store, max = 30) {
  const entries = Object.entries(store?.combos ?? {});
  if (entries.length <= max) return store;
  const keep = entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, max);
  return { combos: Object.fromEntries(keep) };
}

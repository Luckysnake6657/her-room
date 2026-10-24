/**
 * 天气（2026-10-23）。管理员："城市改成宁波，我希望她能有时间观念和天气观念。"
 *
 * 数据来自 open-meteo（免 key、免登录）：`https://api.open-meteo.com/v1/forecast?...`
 * 这里只放**能离线测**的部分：解析、WMO 天气码映射、拼提示词行、判断"明显变化"、算情绪刺激。
 * 网络请求在 bridge.js（定时预读 + 缓存）—— 读失败一律静默，绝不因为天气影响她回话。
 */

/** WMO weather_code → { label: 中文, group: 分组（用于"明显变化"判断）, mood: 情绪方向 -1..1 } */
const WMO = {
  0: ['晴', 'sun', 1],
  1: ['晴间多云', 'sun', 0.7],
  2: ['多云', 'cloud', 0.3],
  3: ['阴', 'cloud', -0.5],
  45: ['雾', 'fog', -0.3],
  48: ['雾凇', 'fog', -0.3],
  51: ['小毛毛雨', 'rain', -0.6],
  53: ['毛毛雨', 'rain', -0.8],
  55: ['大毛毛雨', 'rain', -0.8],
  56: ['冻毛毛雨', 'rain', -0.8],
  57: ['冻毛毛雨', 'rain', -0.8],
  61: ['小雨', 'rain', -0.9],
  63: ['中雨', 'rain', -1],
  65: ['大雨', 'rain', -1],
  66: ['冻雨', 'rain', -1],
  67: ['冻雨', 'rain', -1],
  71: ['小雪', 'snow', -0.9],
  73: ['中雪', 'snow', -1],
  75: ['大雪', 'snow', -1],
  77: ['雪粒', 'snow', -0.9],
  80: ['阵雨', 'rain', -0.8],
  81: ['阵雨', 'rain', -0.9],
  82: ['强阵雨', 'rain', -1],
  85: ['阵雪', 'snow', -0.9],
  86: ['阵雪', 'snow', -1],
  95: ['雷阵雨', 'storm', -1],
  96: ['雷阵雨伴冰雹', 'storm', -1],
  99: ['雷阵雨伴冰雹', 'storm', -1],
};

const FALLBACK = ['天气不明', 'unknown', 0];

/** 天气码 → { label, group, mood }（未知码不编，返回中性）。 */
export function describeCode(code) {
  const hit = WMO[Number(code)];
  if (!hit) return { code: Number(code), label: FALLBACK[0], group: FALLBACK[1], mood: FALLBACK[2] };
  return { code: Number(code), label: hit[0], group: hit[1], mood: hit[2] };
}

/**
 * 解析 open-meteo 的 `current` 对象。
 * 坏数据一律返回 null（宁可这轮不说天气，也不说她编的天气）。
 */
export function parseOpenMeteo(json) {
  try {
    const cur = json?.current ?? json;
    const temp = Number(cur?.temperature_2m);
    const code = Number(cur?.weather_code);
    if (!Number.isFinite(temp) || !Number.isFinite(code)) return null;
    const d = describeCode(code);
    const wind = Number(cur?.wind_speed_10m);
    return {
      temp: Math.round(temp * 10) / 10,
      code,
      label: d.label,
      group: d.group,
      mood: d.mood,
      wind: Number.isFinite(wind) ? Math.round(wind) : null,
      at: Date.now(),
      time: String(cur?.time ?? ''),
    };
  } catch { return null; }
}

/**
 * 拼进提示词的一行。
 * **明确告诉她"这不是要她汇报"** —— 否则每轮都会"今天下雨"变成电台 DJ。
 */
export function formatWeatherLine(data, { city = '宁波', staleMs = 3 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (!data || !data.label || data.label === '天气不明') return '';
  if (data.at && now - data.at > staleMs) return '';   // 数据太旧（挂了半天）就别拿出来说
  const wind = Number.isFinite(data.wind) ? `，风 ${data.wind}km/h` : '';
  return `【今天天气】${city} ${data.label}，${data.temp}℃${wind}\n`
    + '（环境信息而已：不用每轮汇报，聊到天/冷/热/出门/写日记时自然带一句就行。）\n\n';
}

/**
 * "明显变化"判断：只有分组变了（晴↔阴↔雨↔雪）才算，连续两小时小雨不算。
 * @returns {boolean}
 */
export function isNotableChange(prev, cur) {
  if (!prev || !cur) return false;
  if (!prev.group || !cur.group) return false;
  return prev.group !== cur.group;
}

/**
 * 天气对情绪的刺激（只动愉快度 v，权重由调用方给）。
 * 规则：晴天给正、阴天/雾给一点负、雨雪给负；**只在明显变化时调用一次**（见 isNotableChange）。
 * @returns {{v:number,a:number,d:number}}
 */
export function weatherStimulus(cur, weight = 0.12) {
  const mood = Number(cur?.mood);
  if (!Number.isFinite(mood) || mood === 0) return { v: 0, a: 0, d: 0 };
  const w = Math.max(0, Math.min(0.5, Number(weight) || 0));
  return { v: mood * w, a: 0, d: 0 };
}

/** 日记里用的短天气词（"阴"/"毛毛雨"这种，不带温度和风）。 */
export function diaryWeatherLabel(data) {
  if (!data || !data.label || data.label === '天气不明') return '';
  return data.label;
}

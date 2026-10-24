// 桌面壳渲染进程：接桥接真实数据（经 preload 的 api.bridge）。
// 数据源：
//   states  → 会话列表（key/未读/最后唤醒）
//   recent  → 当前会话消息
//   groups  → 群名
//   emotion / diary：主进程读文件（social-v2.json / her-diary）

// 把渲染进程的错误直接显示在窗口底部（白屏时能看出原因）
window.addEventListener('error', (e) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#7f1d1d;color:#fff;padding:6px 10px;font-size:12px;z-index:9999';
  box.textContent = 'JS 错误: ' + (e.message || e.error) + ' @ ' + (e.filename || '') + ':' + (e.lineno || '');
  document.body.appendChild(box);
});
window.addEventListener('unhandledrejection', (e) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#7f1d1d;color:#fff;padding:6px 10px;font-size:12px;z-index:9999';
  box.textContent = 'Promise 错误: ' + (e.reason?.message ?? e.reason);
  document.body.appendChild(box);
});

const $ = (s) => document.querySelector(s);
const clock = $('#clock');
function tick() {
  const d = new Date();
  clock.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
tick(); setInterval(tick, 10000);

// 
const state = {
  key: 'private:984776985',
  conversations: [],
  groups: {},
  messages: [],
  tab: 0,
  forceBottom: false,   // 切会话/首次进入 → 拉到底
};
const API = (p, method = 'GET', body = null) => (window.api ? window.api.bridge({ path: p, method, body }) : Promise.resolve({ ok: false, error: 'no api (preview mode)' }));

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

// QQ 自带表情 → Unicode emoji（2026-10-24：客户端没有 QQ 黄脸图，先映射成系统 emoji）
const QQ_EMOJI = {
  微笑: '😊', 撇嘴: '😕', 色: '😍', 发呆: '😳', 得意: '😎', 流泪: '😭', 害羞: '😳', 闭嘴: '🤐',
  睡: '😴', 大哭: '😭', 尴尬: '😅', 发怒: '😠', 调皮: '😜', 呲牙: '😁', 惊讶: '😲', 难过: '😞',
  酷: '😎', 冷汗: '😓', 抓狂: '😫', 吐: '🤮', 偷笑: '🤭', 可爱: '🥰', 白眼: '🙄', 傲慢: '😤',
  饥饿: '🤤', 困: '😪', 惊恐: '😱', 流汗: '😅', 憨笑: '😄', 奋斗: '💪', 疑问: '❓', 嘘: '🤫',
  晕: '😵', 折磨: '😖', 衰: '😩', 骷髅: '💀', 敲打: '🔨', 再见: '👋', 擦汗: '😅', 抠鼻: '😑',
  鼓掌: '👏', 糗大了: '😳', 坏笑: '😏', 哈欠: '🥱', 鄙视: '😒', 委屈: '🥺', 快哭了: '😢', 阴险: '😏',
  亲亲: '😘', 吓: '😨', 可怜: '🥺', 菜刀: '🔪', 西瓜: '🍉', 啤酒: '🍺', 篮球: '🏀', 乒乓: '🏓',
  咖啡: '☕', 饭: '🍚', 猪头: '🐷', 玫瑰: '🌹', 凋谢: '🥀', 嘴唇: '👄', 爱心: '❤️', 心碎: '💔',
  蛋糕: '🎂', 闪电: '⚡', 炸弹: '💣', 刀: '🔪', 足球: '⚽', 瓢虫: '🐞', 便便: '💩', 月亮: '🌙',
  太阳: '☀️', 礼物: '🎁', 拥抱: '🤗', 强: '👍', 弱: '👎', 握手: '🤝', 胜利: '✌️', 抱拳: '🙏',
  勾引: '😏', 拳头: '👊', 差劲: '👎', 爱你: '😘', NO: '❌', OK: '✅', 爱情: '💑', 飞吻: '😘',
  跳跳: '🤸', 发抖: '😨', 怄火: '😠', 转圈: '🌀', 嘿哈: '😆', 捂脸: '🤦', 奸笑: '😏', 机智: '🤔',
  茶: '🍵', 吃瓜: '🍉', 加油: '💪', 汗: '😓', 天啊: '😱', 社会社会: '😎', 旺柴: '🐶', 打脸: '🤦',
  哇: '😲', 鬼脸: '👻', 皱眉: '😟', 哇哦: '🤩', 裂开: '💔', 666: '👏', 让我看看: '👀', 叹气: '😮‍💨',
  苦涩: '😣', 委屈巴巴: '🥺', 摸鱼: '🐟', 好的: '👌', 收到: '🫡', 鼓掌鼓掌: '👏',
};
function qqEmoji(text) {
  if (!text) return '';
  // 只替换已知的 QQ 表情名，避免误伤 [图片]/[表情包]/[语音] 等占位
  return String(text).replace(/\[([^\[\]]{1,8})\]/g, (whole, name) => QQ_EMOJI[name] || whole);
}
function fmtTime(t) {
  const d = new Date(Number(t) || t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// 
async function loadConversations() {
  const r = await API('/api/socialV2/states');
  if (!r.ok || !r.json?.conversations) return;
  state.conversations = r.json.conversations;
  renderSessions();
}
function updateChatHead() {
  const title = document.getElementById('chatTitle');
  const sub = document.getElementById('chatSub');
  if (!title) return;
  const key = state.key || '';
  const conv = state.conversations.find((c) => c.key === key);
  const isGroup = key.startsWith('group:');
  const name = isGroup
    ? (state.groups[key] || key)
    : (key === 'private:984776985' ? '管理员' : '私聊 ' + key.split(':')[1]);
  title.textContent = name;
  const count = conv?.recentCount ?? 0;
  sub.textContent = (isGroup ? '群聊' : '私聊') + ' · ' + count + ' 条';
}

function renderSessions() {
  const box = $('#sessions');
  updateChatHead();
  // 空会话（没消息、没未读）不显示 —— 之前会冒出 private:123 这种幽灵会话
  const usable = (c) => (Number(c.recentCount) || 0) > 0 || (Number(c.unreadCount) || 0) > 0;
  const priv = state.conversations.filter((c) => c.key.startsWith('private:') && usable(c));
  const grps = state.conversations.filter((c) => c.key.startsWith('group:') && usable(c));
  let html = '<h5>私聊</h5>';
  for (const c of priv) {
    // 私聊可能有多个号：用 QQ 号区分（984776985 = 他）
    const qq = c.key.split(':')[1];
    html += sessionRow(c, qq === '984776985' ? '管理员' : `私聊 ${qq}`);
  }
  html += '<h5>群聊</h5>';
  for (const c of grps) {
    const name = state.groups[c.key] || c.key;
    html += sessionRow(c, name);
  }
  box.innerHTML = html;
  box.querySelectorAll('.session').forEach((el) => {
    el.addEventListener('click', async () => {
      state.key = el.dataset.k;
      state.forceBottom = true;   // 切会话直接拉到底（QQ/微信那样）
      renderSessions();
      loadMessages();
      loadEmotion();
      // 切到一个会话 = 已读：清本地未读 + 通知桥接（2026-10-24）
      const conv = state.conversations.find((c) => c.key === state.key);
      if (conv) conv.unreadCount = 0;
      renderSessions();
      try { await API('/api/socialV2/mark-read', 'POST', { key: state.key }); } catch {}
    });
  });
}
function sessionRow(c, label) {
  const active = c.key === state.key ? ' active' : '';
  const unread = Number(c.unreadCount) || 0;
  const badge = unread > 0 ? `<span class="badge unread">${unread}</span>` : '';
  return `<div class="session${active}" data-k="${esc(c.key)}">${esc(label)}${badge}</div>`;
}

// 
async function loadMessages() {
  const r = await API('/api/socialV2/recent?key=' + encodeURIComponent(state.key) + '&limit=40');
  if (!r.ok || !r.json?.messages) return;
  state.messages = r.json.messages;
  renderMessages();
}
async function loadMessages() {
  const r = await API('/api/socialV2/recent?key=' + encodeURIComponent(state.key) + '&limit=40');
  if (!r.ok || !r.json?.messages) return;
  const prevLast = state.messages[state.messages.length - 1];
  const last = (r.json.messages || [])[r.json.messages.length - 1];
  state.messages = r.json.messages;
  // 有新消息（最后一条变了）→ 如果用户原本在底部就跟着到底（QQ/微信行为）
  if (last && (!prevLast || (last.text !== prevLast.text) || (last.atText !== prevLast.atText))) {
  }
  renderMessages();
}
function renderMessages() {
  updateChatHead();
  const box = $('#messages');
  if (!state.messages.length) {
    box.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:20px;text-align:center">还没有消息</div>';
    return;
  }
  // 粘底（学 QQ/微信）：
  //   切换会话 / 首次进入 → 直接到底
  //   新消息来了 → 原本在底部就跟到底，在翻历史就保持位置（不拽回去）
  const prevTop = box.scrollTop;
  const nearBottom = prevTop + box.clientHeight >= box.scrollHeight - 80;
  const shouldStick = state.forceBottom || nearBottom;
  state.forceBottom = false;
  box.innerHTML = state.messages.map((m) => {
    // 她的第一人称视角：她说的话在右边（"我"），他说的在左边（对方）。
    const mine = m.isSelf ? 'me' : 'her';
    const text = qqEmoji(String(m.text ?? m.plain ?? ''));
    // 媒体：图片/表情直接渲染（QQ CDN 的 url）
    const media = (Array.isArray(m.media) ? m.media : []).map((x) => {
      if (x.kind === 'image' && x.url) return `<img class="msgImg" src="${esc(x.url)}" loading="lazy" onerror="this.style.display='none'">`;
      if (x.kind === 'voice') return '<div class="voice">语音</div>';
      return '';
    }).join('');
    const body = media ? `<div class="bubble media">${media}</div>` : `<div class="bubble">${esc(text)}</div>`;
    // 气泡上方标出发送者：网名（她）+ 管理员（他）；群友用 sender。
    const who = m.isSelf ? '今晚吃兔兔' : (m.isOwner ? '管理员' : (m.sender || '对方'));
    return `<div class="msg ${mine}"><div class="who">${esc(who)}</div>${body}<div class="meta">${esc(m.atText || fmtTime(m.time))}</div></div>`;
  }).join('');
  box.scrollTop = shouldStick ? 1e9 : prevTop;
  if (shouldStick) {
    // 图片是懒加载的：渲染时高度还没算完，滚到底会被后面的图片撑开。
    // 补调只在"用户还在底部附近"时执行（用户已经往上翻就不打扰）。
    const stick = () => {
      try {
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 140) box.scrollTop = box.scrollHeight;
      } catch {}
    };
    requestAnimationFrame(stick);
    setTimeout(stick, 300);
    setTimeout(stick, 800);
  }
}

// 
async function loadEmotion() {
  try {
    const e = await window.api.readEmotion?.();
    if (!e) return;
    const pad = e.pad || [0, 0, 0];
    $('#mood').textContent = `情绪 ${pad.map((x) => Number(x).toFixed(2)).join(' / ')}`;
    const box = $('#panel-mood');
    if (box) {
      box.innerHTML = `<div class="card"><h4>现在</h4>
        <div class="kv"><span>愉快</span><span>${Number(pad[0]).toFixed(2)}</span></div>
        <div class="bar"><i style="width:${Math.round((pad[0] + 1) / 2 * 100)}%"></i></div>
        <div class="kv" style="margin-top:8px"><span>唤醒</span><span>${Number(pad[1]).toFixed(2)}</span></div>
        <div class="bar"><i style="width:${Math.round((pad[1] + 1) / 2 * 100)}%"></i></div>
        <div class="kv" style="margin-top:8px"><span>支配</span><span>${Number(pad[2]).toFixed(2)}</span></div>
        <div class="bar"><i style="width:${Math.round((pad[2] + 1) / 2 * 100)}%"></i></div></div>`;
    }
  } catch {}
}
async function loadDiary() {
  try {
    const d = await window.api.readDiary?.();
    if (!d) return;
    const box = $('#panel-diary');
    if (box) {
      box.innerHTML = d.map((x) => `<div class="card"><h4>${esc(x.date)}</h4><p style="white-space:pre-wrap">${esc(x.text)}</p></div>`).join('');
    }
  } catch {}
}

// 记忆面板（桥接返回的 formatted 文本，2026-10-24）
async function loadMemory() {
  const box = document.getElementById('memBox');
  if (!box) return;
  const r = await API('/api/socialV2/memory?key=' + encodeURIComponent(state.key));
  if (!r.ok || !r.json?.formatted) {
    box.innerHTML = '<p style="color:var(--faint);font-size:12px">记忆为空</p>';
    return;
  }
  box.innerHTML = String(r.json.formatted)
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      if (t.startsWith('【')) return `<h5 style="margin:10px 0 4px;font-size:11px;color:var(--dim)">${esc(t)}</h5>`;
      return `<p style="font-size:13px;line-height:1.6;margin:2px 0">${esc(t)}</p>`;
    })
    .join('');
}

// 

// 
const tabs = [...document.querySelectorAll('.tab')];
function activateTab(idx) {
  tabs.forEach((x, i) => x.classList.toggle('active', i === idx));
  document.querySelectorAll('.panel').forEach((x, i) => x.classList.toggle('active', i === idx));
  state.tab = idx;
  // 切到「网关」时刷新状态
  const tabEl = tabs[idx];
  if (tabEl && tabEl.dataset.tab === 'gateway') loadGateway();
  if (tabEl && tabEl.dataset.tab === 'dsh') loadDsh();
  if (tabEl && tabEl.dataset.tab === 'console') {
    // 控制台的卡也要重新拉（页面加载时桥接可能还没起，之前是空的）
    loadConsole();
    loadRoles();
    loadCliGroups();
    loadAllow();
    loadAccounts();
  }
  // 切到「设置」时刷新配置
  if (tabEl && tabEl.dataset.tab === 'cfg') loadConfig();
}
tabs.forEach((el, i) => el.addEventListener('click', () => activateTab(i)));

// 
async function loadConsole() {
  const kv = (k, v, color) => `<div class="kv"><span>${esc(k)}</span><span${color ? ` style="color:${color}"` : ''}>${esc(v)}</span></div>`;
  const box = $('#cli-status');
  if (!box) return;
  // 注意：静默状态在 /api/socialV2/activity（之前误用 paused → 404，按钮像没反应）
  const [cfgRes, actRes] = await Promise.all([API('/api/socialV2/config'), API('/api/socialV2/activity')]);
  const c = cfgRes?.json?.config || cfgRes?.json || {};
  const a = actRes?.json || {};
  const silent = a.silentAll?.on === true;
  box.innerHTML = [
    kv('服务', c.enabled ? '运行中' : '已停', c.enabled ? 'var(--green)' : 'var(--red)'),
    kv('预设', c.agentPreset || '-'),
    kv('唤醒模式', c.wake?.defaultMode || '-'),
    kv('全局静默', silent ? '开（群不发/不叫醒）' : '关', silent ? 'var(--amber)' : 'var(--green)'),
    kv('暂停', a.paused ? '是' : '否'),
  ].join('');
}
loadConsole();
setInterval(loadConsole, 15000);
document.getElementById('cliSilent')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = '切换中…';
  btn.disabled = true;
  try {
    const cur = (await API('/api/socialV2/activity'))?.json?.silentAll?.on === true;
    const r = await API('/api/socialV2/silent', 'POST', { on: !cur });
    btn.textContent = r.ok ? (r.json?.silentAll?.on ? '已开静默' : '已关静默') : '失败';
    await loadConsole();
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
});
document.getElementById('cliRefresh')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.textContent = '刷新中…';
  await loadConsole();
  btn.textContent = '刷新';
});
document.getElementById('cliFull')?.addEventListener('click', async () => {
  const t = await window.api?.consoleToken?.();
  window.api?.openUrl?.(`http://127.0.0.1:3100/?token=${encodeURIComponent(t || '')}`);
});

// 唤醒模式（潜水/活跃）——改她的会话 wakeConfig
async function loadWakeMode() {
  const hint = document.getElementById('cliWakeHint');
  if (!hint) return;
  const r = await API('/api/socialV2/state?key=' + encodeURIComponent(state.key));
  const mode = r?.json?.wakeConfig?.mode || '-';
  hint.textContent = '当前：' + (mode === 'active' ? '活跃' : mode === 'diving' ? '潜水' : mode);
  document.querySelectorAll('#cliWake .btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.wake === mode);
  });
}
loadWakeMode();
document.querySelectorAll('#cliWake .btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const hint = document.getElementById('cliWakeHint');
    if (hint) hint.textContent = '切换中…';
    const r = await API('/api/socialV2/wake-config', 'POST', {
      key: state.key,
      config: { mode: btn.dataset.wake, infinite: true, triggers: { atMention: true, nameMention: true, speakerIds: [], keywords: [], question: true, poke: true, anyMessage: btn.dataset.wake === 'active' } },
    });
    if (hint) hint.textContent = r.ok ? '已切换' : '切换失败';
    setTimeout(loadWakeMode, 800);
  });
});

// 代发测试（test-send，用她的号发到管理员）
document.getElementById('cliSend')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('cliMsg');
  const hint = document.getElementById('cliSendHint');
  const msg = (input?.value || '').trim();
  if (!msg) return;
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const r = await API('/api/test-send', 'POST', { kind: 'private', id: 984776985, message: msg });
    if (hint) hint.textContent = r.ok ? '已发到管理员私聊（用她的号）' : `失败：${r.json?.error || r.error || '未知'}`;
    if (r.ok && input) input.value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
  }
});

// 人设 / 群聊 / 白名单 / 账号（控制台卡片，2026-10-25）
async function loadRoles() {
  const box = document.getElementById('cliRoles');
  if (!box) return;
  const r = await API('/api/roles');
  const role = r?.json?.roles || [];
  const cur = r?.json?.current || '';
  if (!role.length) { box.innerHTML = '<p style="color:var(--faint);font-size:12px">没有角色卡</p>'; return; }
  box.innerHTML = role.map((n) => {
    const isCur = n === cur;
    return '<div class="kv roleItem" data-role="' + esc(n) + '" style="cursor:pointer"><span>' + esc(n) + (isCur ? '（当前）' : '') + '</span><span>' + (isCur ? '✔' : '点击切换') + '</span></div>';
  }).join('');
  box.querySelectorAll('.roleItem').forEach((el) => {
    el.addEventListener('click', async () => {
      const name = el.dataset.role;
      const r2 = await API('/api/role', 'POST', { role: name });
      if (r2.ok) await loadRoles();
    });
  });
}
async function loadCliGroups() {
  const box = document.getElementById('cliGroups');
  if (!box) return;
  const r = await API('/api/socialV2/groups?all=1');
  const gs = r?.json?.groups || [];
  if (!gs.length) { box.innerHTML = '<p style="color:var(--faint);font-size:12px">没有群</p>'; return; }
  box.innerHTML = gs.map((g) => {
    const conv = state.conversations.find((c) => c.key === g.key);
    const unread = Number(conv?.unreadCount) || 0;
    return '<div class="kv" style="cursor:pointer" data-gkey="' + esc(g.key) + '"><span>' + esc(g.name || g.id) + '</span><span>' + (unread > 0 ? unread + ' 未读' : '·') + '</span></div>';
  }).join('');
  // 点群 = 切到这个群（聊天区跟着走）
  box.querySelectorAll('[data-gkey]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.key = el.dataset.gkey;
      state.forceBottom = true;
      renderSessions();
      loadMessages();
      loadEmotion();
      try { await API('/api/socialV2/mark-read', 'POST', { key: state.key }); } catch {}
      loadCliGroups();
    });
  });
}
async function loadAllow() {
  const box = document.getElementById('cliAllow');
  if (!box) return;
  const a = await window.api?.readAllow?.();
  if (!a) return;
  box.innerHTML = [
    '<div class="wzRow"><label>私聊白名单</label><input id="allowPrivate" placeholder="QQ 号，逗号分隔" value="' + esc((a.private || []).join(',')) + '" /><button class="btn" id="allowPrivateSave">保存</button></div>',
    '<div class="wzRow"><label>群白名单</label><input id="allowGroups" placeholder="群号，逗号分隔" value="' + esc((a.groups || []).join(',')) + '" /><button class="btn" id="allowSave">保存</button></div>',
  ].join('');
  const toList = (v) => (v ? v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) : []);
  const pbtn = document.getElementById('allowPrivateSave');
  if (pbtn) {
    pbtn.onclick = async () => {
      const list = toList((document.getElementById('allowPrivate')?.value || '').trim());
      const ok = await window.api?.saveAllow?.({ private: list });
      pbtn.textContent = ok ? '已保存（重启桥接生效）' : '保存失败';
      setTimeout(() => { pbtn.textContent = '保存'; }, 2000);
    };
  }
  const btn = document.getElementById('allowSave');
  if (btn) {
    btn.onclick = async () => {
      const groups = toList((document.getElementById('allowGroups')?.value || '').trim());
      const ok = await window.api?.saveAllow?.({ groups });
      btn.textContent = ok ? '已保存（重启桥接生效）' : '保存失败';
      setTimeout(() => { btn.textContent = '保存'; }, 2000);
    };
  }
}
async function loadAccounts() {
  const box = document.getElementById('cliAccounts');
  if (!box) return;
  const s = await window.api?.status?.();
  if (!s) return;
  const row = (k, v) => '<div class="kv"><span>' + esc(k) + '</span><span>' + esc(v || '—') + '</span></div>';
  box.innerHTML = [
    row('机器人 QQ', s.botQQ),
    row('机器人昵称', s.qqNickname),
    row('人格名', s.personaName),
    '<div class="wzRow" style="margin-top:6px"><label>管理员 QQ</label><input id="ownerQQ" value="' + esc(s.ownerQQ || '') + '" /><button class="btn" id="ownerSave">保存</button></div>',
  ].join('');
  const btn = document.getElementById('ownerSave');
  if (btn) {
    btn.onclick = async () => {
      const qq = (document.getElementById('ownerQQ')?.value || '').trim();
      const ok = await window.api?.saveOwner?.(qq);
      btn.textContent = ok ? '已保存（重启桥接生效）' : '失败';
      setTimeout(() => { btn.textContent = '保存'; }, 2000);
    };
  }
}
loadRoles(); loadCliGroups(); loadAllow(); loadAccounts();
// 
// 她的独立 DSH 实例（3081）：状态 / 当前会话 / 重启 / 日志。
async function loadDsh() {
  const s = await window.api?.status?.();
  if (!s) return;
  const kv = (k, v, color) => `<div class="kv"><span>${esc(k)}</span><span${color ? ` style="color:${color}"` : ''}>${esc(v)}</span></div>`;
  const box = $('#dsh-status');
  if (box) {
    box.innerHTML = [
      kv('实例', 'D:\\QQaibot\\dsh-her'),
      kv('端口 3081', s.herDsh ? '在线' : '离线', s.herDsh ? 'var(--green)' : 'var(--red)'),
      kv('桥接连接', s.bridge ? '正常' : '断开', s.bridge ? 'var(--green)' : 'var(--red)'),
      kv('模型', 'deepseek-flash / high'),
    ].join('');
  }
  const ses = $('#dsh-session');
  if (ses) {
    const conv = state.conversations.find((c) => c.key === state.key);
    ses.innerHTML = [
      kv('当前会话', state.key),
      kv('消息数', String(conv?.recentCount ?? '-')),
      kv('会话 id', conv?.sessionId || '（桥接未上报）'),
    ].join('');
  }
}
loadDsh();
setInterval(loadDsh, 10000);
document.getElementById('dshRestart')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ok = confirm('重启她的 DSH？会话会重建（记忆在桥接里，不会丢）');
  if (!ok) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重启中…（约 30 秒）';
  try {
    await window.api?.restartDsh?.();
    // 等 3081 重新监听（最多 90 秒）
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await window.api?.status?.();
      if (s?.herDsh) break;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    loadDsh();
  }
});
document.getElementById('dshOpen')?.addEventListener('click', async () => {
  const url = (await window.api?.herDshUrl?.()) || 'http://127.0.0.1:3081';
  window.api?.openUrl?.(url);
});
document.getElementById('dshLogs')?.addEventListener('click', () => window.api?.openPath?.('D:\\QQaibot\\dsh-her\\guard\\logs'));
document.getElementById('dshBackup')?.addEventListener('click', async () => {
  const hint = document.getElementById('backupHint');
  if (hint) hint.textContent = '正在备份…';
  const out = await window.api?.backupHer?.();
  if (hint) {
    hint.textContent = out
      ? `已备份：${out}`
      : '备份失败（看 D:\\QQaibot\\backups 权限/磁盘）';
    if (out) window.api?.openPath?.('D:\\QQaibot\\backups');
  }
});

// 
// 2026-10-24：不再嵌 6099（风格不搭、还会空白），改成状态卡 + 操作按钮。
async function loadGateway() {
  const s = await window.api?.status?.();
  if (!s) return;
  const kv = (k, v, color) => `<div class="kv"><span>${esc(k)}</span><span${color ? ` style="color:${color}"` : ''}>${esc(v)}</span></div>`;
  const box = $('#gw-status');
  if (!box) return;
  const ok = (b) => (b ? '在线' : '离线');
  box.innerHTML = [
    kv('NapCat 进程', ok(s.napcat), s.napcat ? 'var(--green)' : 'var(--red)'),
    kv('OneBot WS', '3002', s.napcat ? 'var(--green)' : 'var(--red)'),
    kv('OneBot HTTP', '3003', s.napcat ? 'var(--green)' : 'var(--red)'),
    kv('WebUI', '6099', s.napcatWeb ? 'var(--green)' : 'var(--red)'),
    kv('桥接', ok(s.bridge), s.bridge ? 'var(--green)' : 'var(--red)'),
  ].join('');
}
loadGateway();
setInterval(loadGateway, 5000);
// 网关操作按钮：给即时反馈（重启 NapCat 要 30~60 秒，之前按了像没反应）
async function withFeedback(btn, label, action) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await action(); } finally {
    btn.disabled = false;
    btn.textContent = old;
    loadGateway();
  }
}
document.getElementById('gwRestart')?.addEventListener('click', (e) => withFeedback(e.currentTarget, '重启中…（约 30 秒）', async () => {
  await window.api?.restartNapcat?.();
  // 等 NapCat 重新监听（最多 90 秒）
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await window.api?.status?.();
    if (s?.napcat) break;
  }
}));
document.getElementById('gwLogin')?.addEventListener('click', (e) => withFeedback(e.currentTarget, '登录中…（约 30 秒）', async () => {
  await window.api?.restartNapcat?.();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await window.api?.status?.();
    if (s?.napcat) break;
  }
}));
document.getElementById('gwWebui')?.addEventListener('click', () => {
  window.api?.openUrl?.('http://127.0.0.1:6099');
});

// 
async function loadConfig() {
  const r = await API('/api/socialV2/config');
  if (!r.ok || !r.json) return;
  const c = r.json.config || r.json;
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  const sw = (k, on) => `<div class="tool"><span>${esc(k)}</span><div class="switch ${on ? 'on' : ''}"></div></div>`;
  const run = $('#cfg-run');
  if (run) {
    run.innerHTML = [
      kv('服务', c.enabled ? '运行中' : '已停'),
      kv('预设', c.agentPreset || '-'),
      kv('回复检查', `${Math.round((c.autoReplyCheckMs || 0) / 1000)} 秒`),
      kv('桥接', '3100'),
      kv('QQ 网关', 'NapCat 3002/3003'),
      kv('她的 DSH', '3081'),
    ].join('');
  }
  const beh = $('#cfg-behavior');
  if (beh) {
    const p = c.proactive || {};
    const w = c.wake || {};
    const s = c.session || {};
    beh.innerHTML = [
      kv('主动检查', `${Math.round((p.checkIntervalMinMs || 0) / 60000)} ~ ${Math.round((p.checkIntervalMaxMs || 0) / 60000)} 分钟`),
      kv('主动概率', `${Math.round((p.probability || 0) * 100)}%`),
      kv('独处阈值', `${Math.round((p.idleThresholdMs || 0) / 60000)} 分钟`),
      kv('唤醒模式', w.defaultMode || '-'),
      kv('历史轮换', `${Math.round((s.maxHistoryBytes || 0) / 1048576)} MB`),
      kv('轮换补上下文', `${s.seedMsgs || 0} 条 / ${s.seedChars || 0} 字`),
    ].join('');
  }
  const swi = $('#cfg-switches');
  if (swi) {
    swi.innerHTML = [
      sw('服务总开关', !!c.enabled),
      sw('情绪', !!(c.emotion && c.emotion.enabled)),
      sw('记忆', !!(c.memory && c.memory.enabled)),
      sw('主动', !!(c.proactive && c.proactive.enabled)),
      sw('日记', !!(c.diary && c.diary.enabled)),
    ].join('');
  }
}
loadConfig();
setInterval(loadConfig, 30000);

// 
document.getElementById('winMin')?.addEventListener('click', () => window.api?.winMinimize?.());
document.getElementById('winMax')?.addEventListener('click', () => window.api?.winMaximize?.());
document.getElementById('winClose')?.addEventListener('click', () => window.api?.winClose?.());

// 
async function loadGroups() {
  const r = await API('/api/socialV2/groups?all=1');
  if (r.ok && r.json?.groups) {
    state.groups = {};
    for (const g of r.json.groups) state.groups[g.key] = g.name || g.key;
  }
}
async function loadCapabilities() {
  const box = document.getElementById('capList');
  if (!box) return;
  const c = await window.api?.readCapabilities?.();
  if (!c) {
    box.innerHTML = '<p style="color:var(--faint);font-size:12px">没检测到能力清单（跑一次 node scripts\\detect-capabilities.mjs）</p>';
    return;
  }
  const row = (k, v, hint) => {
    const ok = !!v;
    return `<div class="tool"><span>${esc(k)}</span><span class="status ${ok ? 'on' : 'off'}">${ok ? '● 可用' : '○ 不可用'}${!ok && hint ? ` · ${esc(hint)}` : ''}</span></div>`;
  };
  box.innerHTML = [
    row('聊天 / 情感 / 记忆 / 日记', true),
    row('表情包', c.stickers),
    row('语音', c.voice),
    row('手机控制（adb）', c.phone, '缺 adb/设备'),
    row('MATLAB', c.matlab, '没装 MATLAB'),
    row('B 站', c.bili, '没配 cookie'),
    row('完美战绩', c.wmpvp, '没配 token'),
  ].join('');
}
loadCapabilities();

async function loadToolLog() {
  const r = await API('/api/socialV2/tool-log?limit=6');
  if (!r.ok || !r.json?.entries) return;
  const box = $('#toolLog');
  if (box) {
    box.innerHTML = r.json.entries.slice().reverse().map((e) =>
      `<p>${fmtTime(e.time)} ${esc(e.tool)} ${e.ok ? '✓' : '✗'}</p>`).join('');
  }
}

let dataStarted = false;
async function startData() {
  if (dataStarted) return;
  dataStarted = true;
  await loadGroups();
  await loadConversations();
  await loadMessages();
  await loadEmotion();
  await loadDiary();
  await loadMemory();
  await loadToolLog();
  setInterval(loadMessages, 3000);
  setInterval(loadConversations, 5000);
  setInterval(loadToolLog, 5000);
  setInterval(loadEmotion, 10000);
}

// 
// 首次向导：填目录/QQ号 → 保存 settings.json → 重启（配置生效）
async function showWizard() {
  const get = (id) => document.getElementById(id);
  const bridge = get('wzBridge');
  const her = get('wzHer');
  const napcat = get('wzNapcat');
  const qq = get('wzQQ');
  const name = get('wzName');
  if (!bridge) return;
  // 自动探测：常见位置存在就预填（空了才填，不覆盖用户输入）
  const det = (await window.api?.detectPaths?.()) || {};
  bridge.value = bridge.value || det.bridgeDir || 'D:\\qq-bridge';
  her.value = her.value || det.herDshDir || 'D:\\QQaibot\\dsh-her';
  napcat.value = napcat.value || det.napcatDir || 'D:\\QQaibot\\napcat';
  
  const pick = async (input) => {
    const p = await window.api?.pickDir?.();
    if (p) input.value = p;
  };
  get('wzPickBridge').onclick = () => pick(bridge);
  get('wzPickHer').onclick = () => pick(her);
  get('wzPickNapcat').onclick = () => pick(napcat);
  get('wzSave').onclick = async () => {
    // QQ 号必填：空了 NapCat 会默认登成 QQ 里当前登录的号（别人的大号）
    const qqVal = qq.value.trim();
    if (!/^\d{5,12}$/.test(qqVal)) {
      const hint = document.getElementById('bootText');
      if (hint) hint.textContent = 'QQ 号必须填（机器人用的号，5~12 位数字）——不能空，空了会误登成 QQ 里当前登录的号。';
      qq.focus();
      return;
    }
    const ok = await window.api?.saveSettings?.({
      bridgeDir: bridge.value.trim(),
      herDshDir: her.value.trim(),
      napcatDir: napcat.value.trim(),
      qq: qqVal,
      personaName: name.value.trim(),
    });
    // API key（可选，填了才写进她的 .credentials.yaml）
    const apiKeyEl = get('wzKey');
    const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
    if (apiKey) await window.api?.saveCredentials?.(apiKey);
    // 人格卡（可选，填了才写 roles/<人格名>.md；已有会备份 .bak）
    const cardEl = get('wzCard');
    const card = cardEl ? cardEl.value.trim() : '';
    const pName = name.value.trim() || '默认';
    if (card) {
      await window.api?.savePersonaCard?.({ name: pName, text: card });
    } else {
      // 没填人格卡：按 QQ 号生成一份个性化的默认人设（生日/星座每个人不同）
      const made = await window.api?.makePersona?.(qqVal);
      if (made) document.getElementById('bootText').textContent = `已生成默认人设（生日 ${made}）。`;
    }
    if (ok) {
      document.getElementById('bootTitle').textContent = '配置已保存，正在重启…';
      // 重启应用让配置生效（简单可靠）
      setTimeout(() => window.api?.winClose?.(), 800);
    }
  };
}

async function bootCheck() {
  const boot = document.getElementById('boot');
  const card = document.getElementById('bootCard');
  const title = document.getElementById('bootTitle');
  const text = document.getElementById('bootText');
  const actions = document.getElementById('bootActions');
  const qr = document.getElementById('bootQr');
  const s = await window.api?.status?.();
  if (!s) { setTimeout(bootCheck, 2000); return; }
  // 人格名跟着配置走（settings.personaName；空则 "AI 助手"）
  if (s.personaName) {
    const pn = document.getElementById('personaName');
    if (pn) pn.textContent = s.personaName;
    document.title = s.personaName;
  }
  if (s.bridge) {
    boot?.classList.add('hidden');
    startData();
    return;
  }
  if (Array.isArray(s.configProblems) && s.configProblems.length) {
    // 首次向导：直接给表单填（不用手改 json）
    const wz = document.getElementById('bootWizard');
    title.textContent = '第一次配置';
    text.textContent = '选好目录、填上 QQ 号，点保存就会开始。缺的项：' + s.configProblems.join('；');
    actions.innerHTML = '';
    if (qr) qr.style.display = 'none';
    card?.classList.add('wide');
    if (wz && wz.style.display !== 'block') {
      wz.style.display = 'block';
      showWizard();
    }
    setTimeout(bootCheck, 3000);
    return;
  }
  const wzHide = document.getElementById('bootWizard');
  if (wzHide) wzHide.style.display = 'none';
  if (!s.dshInstalled) {
    // 没装 DSH：引擎缺失，先提示（装了之后重启这个应用即可）
    title.textContent = '没有找到 DSH';
    text.textContent = '这个应用需要一个 DSH 实例当大脑。请先安装：npm i -g @deepseek-ai/dsh（或改 settings.json 的 dshBin 指向你已装的版本）。';
    actions.innerHTML = '';
    if (qr) qr.style.display = 'none';
    card?.classList.remove('wide');
    setTimeout(bootCheck, 3000);
    return;
  }
  if (s.snowlumaRunning) {
    // 环境冲突：SnowLuma 在跑（3001/5099），同一个 QQ 号会被它 hook，NapCat 再 hook 会打架
    title.textContent = '检测到 SnowLuma 在运行';
    text.textContent = '这台机器上已经有 SnowLuma（另一个 QQ 网关）。同一个 QQ 号不能被两个网关同时接管——继续用 NapCat 可能把两边都搞乱。建议先退出 SnowLuma，再点下面继续。';
    actions.innerHTML = '<button class="btn" id="bootContinue">已经关了，继续</button><button class="btn" id="bootOpenSl">打开 SnowLuma 目录</button>';
    document.getElementById('bootContinue').onclick = () => { state.skipSnowlumaCheck = true; bootCheck(); };
    document.getElementById('bootOpenSl').onclick = () => window.api?.openPath?.('D:\\SnowLuma');
    if (qr) qr.style.display = 'none';
    card?.classList.remove('wide');
    if (!state.skipSnowlumaCheck) { setTimeout(bootCheck, 3000); return; }
  }
  if (!s.qqRunning) {
    // 跟 QQ/微信一样：先检测登录态，没登录就引导
    title.textContent = s.qqInstalled ? '请先登录 QQ' : '没有找到 QQ';
    text.textContent = s.qqInstalled
      ? 'QQ 没在运行。点下面打开 QQ 并登录（机器人用的就是这个号），登录后这里会自动继续。'
      : '没有找到 QQ（NT），请先安装腾讯 QQ 并登录一次，再打开这个应用。';
    actions.innerHTML = s.qqInstalled ? '<button class="btn" id="bootQQ">打开 QQ</button>' : '';
    const b = document.getElementById('bootQQ');
    if (b) b.onclick = () => window.api?.launchQQ?.();
    if (qr) qr.style.display = 'none';
    card?.classList.remove('wide');
  } else if (!s.napcat) {
    // 网关没起：让用户点按钮（会弹一次 UAC）
    title.textContent = '需要启动 QQ 网关';
    text.textContent = 'NapCat 没在运行。点下面的按钮启动（会弹一次系统确认），启动后这里会直接出现二维码。';
    actions.innerHTML = '<button class="btn" id="bootStart">启动 QQ 网关</button>';
    document.getElementById('bootStart').onclick = () => window.api?.startNapcat?.();
    if (qr) qr.style.display = 'none';
    card?.classList.remove('wide');
  } else if (!s.napcatWeb) {
    title.textContent = 'QQ 网关启动中…';
    text.textContent = '正在等待二维码生成（约 5~15 秒）…';
    actions.innerHTML = '';
    if (qr) qr.style.display = 'none';
    card?.classList.remove('wide');
  } else {
    // NapCat 在线但桥接还没起。两种情况：
    //   A) 真需要扫码（NapCat 生成了新的 qrcode.png）→ 显示二维码
    //   B) 只是服务在启动 → 显示"正在启动"，别一闪而过（2026-10-25 修）
    const needQr = s.needQr && s.needQr.fresh && s.needQr.file;
    const waited = Date.now() - (state.bootSince || (state.bootSince = Date.now()));
    if (needQr) {
      title.textContent = '扫码登录 QQ';
      text.textContent = '网关需要登录。用手机 QQ 扫下面的码（扫的是跑 bot 的那个号），登录后这里会自动继续。';
      actions.innerHTML = '';
      card?.classList.add('wide');
      if (qr) {
        qr.style.display = 'block';
        qr.src = 'file:///' + s.needQr.file + '?t=' + Date.now();
      }
    } else {
      title.textContent = '正在启动服务…';
      text.textContent = waited > 25000
        ? '服务起得有点慢。如果一直停在这里，可能是网关需要重新登录——点下面。'
        : '网关已就绪，正在拉起桥接和她的 DSH。';
      actions.innerHTML = waited > 25000 ? '<button class="btn" id="bootRelogin">重新登录网关</button>' : '';
      const rb = document.getElementById('bootRelogin');
      if (rb) rb.onclick = () => window.api?.restartNapcat?.();
      card?.classList.remove('wide');
      if (qr) qr.style.display = 'none';
    }
  }
  setTimeout(bootCheck, 3000);
}
bootCheck();

// 
document.getElementById('themeBtn')?.addEventListener('click', () => {
  prefs.theme = prefs.theme === 'light' ? 'dark' : 'light';
  applyPrefs();
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
});
document.getElementById('notifyBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await Promise.all([loadGroups(), loadConversations(), loadMessages(), loadEmotion(), loadDiary(), loadMemory(), loadToolLog()]);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});
document.getElementById('search')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#messages .msg').forEach((el) => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('#panel-mem .card').forEach((el) => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
});

// 
const PREF_KEY = 'qqai-prefs';
const DEFAULT_PREFS = { theme: 'dark', font: '14', glass: '28', anim: '1', wallpaper: '', wallPos: 'center', wallFit: 'cover' };
let prefs = { ...DEFAULT_PREFS };
try { prefs = { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}')) }; } catch {}

function applyPrefs() {
  document.body.classList.toggle('light', prefs.theme === 'light');
  // 字号：整体缩放（webFrame zoom）——改 font-size 对固定像素的组件无效，缩放到全界面才明显
  const zoomMap = { '12': 0.92, '14': 1.0, '16': 1.08 };
  // 用 CSS zoom（布局跟着缩放）而不是 webFrame zoom（后者会造成固定像素元素错位）
  const z = zoomMap[String(prefs.font)] || 1.0;
  document.body.style.zoom = String(z);
  // zoom 会让 100vh 实际变成 (100vh × z)，补偿回来，否则底部会多出一条
  document.documentElement.style.setProperty('--ui-zoom', String(z));
  document.documentElement.style.setProperty('--glass-blur', `${prefs.glass}px`);
  document.body.classList.toggle('no-anim', prefs.anim === '0');
  // 壁纸：只在 #wallLayer 上挂一次 background-image（全局坐标系），
  // 面板只做 backdrop-filter —— 三栏透过同一张图，接缝不会撕裂。
  const layer = document.getElementById('wallLayer');
  if (prefs.wallpaper && layer) {
    document.body.classList.add('has-wallpaper');
    layer.classList.add('on');
    const scale = Math.max(0.5, Math.min(4, Number(prefs.wallScale) || 1));
    // 缩放用 background-size（不用 transform）；位置用背景偏移（相对屏幕中心）
    layer.style.backgroundImage = `url("${String(prefs.wallpaper).replace(/"/g, '\\"')}")`;
    layer.style.backgroundSize = scale === 1 ? 'cover' : `${Math.round(scale * 100)}% auto`;
    const dx = Number(prefs.wallX) || 0;
    const dy = Number(prefs.wallY) || 0;
    layer.style.backgroundPosition = `calc(50% + ${dx}px) calc(50% + ${dy}px)`;
  } else {
    document.body.classList.remove('has-wallpaper');
    layer?.classList.remove('on');
    if (layer) {
      layer.style.backgroundImage = '';
      layer.style.backgroundSize = 'cover';
      layer.style.backgroundPosition = 'center center';
    }
  }
  document.querySelectorAll('[data-pref]').forEach((btn) => {
    // 选中态交给 CSS（.active 用 accent 底 + 白字），不要内联 style 覆盖
    btn.classList.toggle('active', String(prefs[btn.dataset.pref]) === String(btn.dataset.v));
  });
}
document.querySelectorAll('[data-pref]').forEach((btn) => {
  btn.addEventListener('click', () => {
    prefs[btn.dataset.pref] = btn.dataset.v;
    applyPrefs();
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
  });
});
// 壁纸取景器（二级菜单）：拖动移动、滚轮缩放、确定/取消
let wp = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
function openWallPicker(src) {
  const picker = document.getElementById('wallPicker');
  const preview = document.getElementById('wallPreview');
  if (!picker || !preview) return;
  wp = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
  preview.setAttribute('src', src);
  preview.style.transform = 'translate(0px, 0px) scale(1)';
  picker.classList.add('on');
}
function closeWallPicker() {
  document.getElementById('wallPicker')?.classList.remove('on');
}
document.getElementById('wallPick')?.addEventListener('click', async () => {
  const p = await window.api?.pickWallpaper?.();
  if (!p) return;
  openWallPicker('file:///' + String(p).replace(/\\/g, '/'));
});
document.getElementById('wallClear')?.addEventListener('click', () => {
  prefs.wallpaper = '';
  prefs.wallX = 0;
  prefs.wallY = 0;
  prefs.wallScale = 1;
  applyPrefs();
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
});
// 天气城市（写 config.socialV2.weather，桥接重启后生效）
document.getElementById('weatherSave')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const city = (document.getElementById('weatherCity')?.value || '').trim();
  if (!city) return;
  btn.disabled = true;
  btn.textContent = '保存中…';
  const ok = await window.api?.saveWeather?.(city);
  btn.textContent = ok ? '已保存（重启桥接生效）' : '保存失败';
  setTimeout(() => { btn.textContent = '保存'; btn.disabled = false; }, 2000);
});
document.getElementById('wallOk')?.addEventListener('click', () => {
  const src = document.getElementById('wallPreview')?.getAttribute('src') || '';
  if (src) {
    prefs.wallpaper = src;
    prefs.wallX = Math.round(wp.x);
    prefs.wallY = Math.round(wp.y);
    prefs.wallScale = Number(wp.scale.toFixed(3));
  }
  applyPrefs();
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
  closeWallPicker();
});
document.getElementById('wallCancel')?.addEventListener('click', closeWallPicker);
// 拖动 / 缩放（只在取景器打开时生效）
{
  const preview = document.getElementById('wallPreview');
  const stage = document.querySelector('.wallStage');
  const render = () => {
    if (preview) preview.style.transform = `translate(${wp.x}px, ${wp.y}px) scale(${wp.scale})`;
  };
  preview?.addEventListener('mousedown', (e) => {
    wp.dragging = true; wp.lastX = e.clientX; wp.lastY = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!wp.dragging) return;
    wp.x += e.clientX - wp.lastX;
    wp.y += e.clientY - wp.lastY;
    wp.lastX = e.clientX; wp.lastY = e.clientY;
    render();
  });
  window.addEventListener('mouseup', () => { wp.dragging = false; });
  stage?.addEventListener('wheel', (e) => {
    if (!document.getElementById('wallPicker')?.classList.contains('on')) return;
    e.preventDefault();
    const next = Math.min(4, Math.max(0.5, wp.scale * (e.deltaY < 0 ? 1.08 : 0.92)));
    wp.scale = next;
    render();
  }, { passive: false });
}
applyPrefs();

// 
window.addEventListener('keydown', (e) => {
  // 输入框里打字时不拦截
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (e.key === 'Escape') {
    document.getElementById('wallPicker')?.classList.remove('show');
    return;
  }
  if (!e.ctrlKey || e.altKey) return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    loadConversations(); loadMessages(); loadEmotion(); loadDiary(); loadMemory(); loadToolLog();
    return;
  }
  if (typing) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 8) {
    e.preventDefault();
    activateTab(n - 1);
  }
});

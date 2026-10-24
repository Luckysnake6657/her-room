// 探测完美世界竞技平台 / 5E 的网页与接口可达性。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000)
    });
    return { status: r.status, text: await r.text(), url: r.url };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, url };
  }
};

const targets = [
  ['完美 竞技平台主站', 'https://www.csgo.com.cn/'],
  ['完美 战绩查询帮助页', 'https://www.csgo.com.cn/app/data/20170421/202432.shtml'],
  ['完美 电竞平台', 'https://platform.wanmei.com/'],
  ['完美 arena', 'https://arena.wanmei.com/'],
  ['5E 主站', 'https://www.5eplay.com/'],
  ['5E 对战平台', 'https://www.5eplay.com/arena'],
  ['5E 玩家页示例', 'https://www.5eplay.com/'],
  ['5E API 探测', 'https://gate.5eplay.com/'],
  ['5E 另一个域', 'https://www.5earena.com/']
];

for (const [name, url] of targets) {
  const r = await get(url);
  const flags = [];
  if (/api|json/i.test(r.text.slice(0, 3000))) flags.push('提到api/json');
  if (/登录|login/i.test(r.text)) flags.push('有登录');
  console.log(`  ${String(r.status).padEnd(4)} ${name}  len=${r.text.length}${flags.length ? '  [' + flags.join('/') + ']' : ''}`);
  console.log(`       ${url} → ${r.url}`);
  if (r.status === 200 && r.text.length < 500) console.log(`       ${r.text.replace(/\s+/g, ' ').slice(0, 180)}`);
}

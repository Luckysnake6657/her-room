// 把 mcp-snowluma-safe.js 里"按需读文本分段"与"按需看文档图"两个工具
// 合并成一个 qq_read_file（职责重叠：都是"看某个文件里的一段/一页"）。
//
// 为什么合并：工具定义**每轮都进上下文**，实测 58 个工具 = 32389 字符 ≈ 10800 token。
// 两个工具的描述各 ~800 字符，合并后只留一份。
import fs from 'node:fs';

const F = 'src/mcp-snowluma-safe.js';
let s = fs.readFileSync(F, 'utf8');

const START = s.indexOf('// ── 按需读文本文件的某一段（大文件她只看到开头）');
const END = s.indexOf('// ── 表情包体系工具（二代仿真模式）');
if (START < 0 || END < 0 || END <= START) {
  console.error('❌ 找不到要替换的区块（START=%d END=%d）', START, END);
  process.exit(1);
}

const MERGED = `// ── 按需看文件：文本文件的某一段 / 文档的某一页图 ──────────────────────────
// 用户场景（两件事其实是一件事："我发的那个文件，某处到底写的什么"）：
//   • 11MB 的台版小说 txt，她只看得到开头 → 需要按行/按关键词翻；
//   • 19 页的汇报 PPT，默认只附几页图 → 需要翻到"第 N 页"看图。
// 所以合成一个入口，按参数自动选模式，省一份工具描述（每轮都要带的 token）。
if (cfg.socialV2?.tools?.readFile !== false) {
  server.tool(
    'qq_read_file',
    '按需看某个**文件**里的一段/一页（他发过的 txt/log/md/csv，或 PPT/Word/Excel）：\\n'
    + '- 文本文件 → 按行取段（from/to）或按关键词找（keyword，像 grep 一样给命中行和上下文）；\\n'
    + '- 文档 → 按页看（pages 写 "3" / "3,5,7" / "3-8"），图和那几页的文字一起给你。\\n'
    + '用在：他发过大文件，你只看到开头和结尾，现在要读中间某一段、或确认"第 N 页那张图长什么样"。\\n'
    + 'file 可只写一部分名字（如 "无职转生"、"步进电机"）；不传就取这个会话最近收到的那份。\\n'
    + '一次只回一小段（文本默认 4000 字符 / 图默认几张），需要更多就多调几次；返回里有 nextFrom 可以接着往下读。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      file: z.string().optional().describe('文件名（可只写一部分）或 fileId；不传就取这个会话最近收到的那份文件'),
      pages: z.string().optional().describe('【文档】要看的页，如 "3" / "3,5,7" / "3-8"（一次最多 20 页）；不传则取最值得看的几张图'),
      from: z.number().optional().describe('【文本】从第几行开始（1 起算，默认 1）'),
      to: z.number().optional().describe('【文本】读到第几行；不传就从 from 开始装到 maxChars 为止'),
      keyword: z.string().optional().describe('【文本】按关键词查找（给了它就忽略 from/to），返回最多 8 处命中的行号和上下文'),
      maxChars: z.number().optional().describe('【文本】本条最多返回多少字符（默认 4000，上限 20000）')
    },
    async ({ key, token, file, pages, from, to, keyword, maxChars }) => {
      const headers = token ? { 'x-agent-token': token } : {};
      const wantDoc = !!pages;                       // 明确要页 → 文档模式
      const wantText = keyword != null || from != null || to != null;   // 明确要行/词 → 文本模式
      const callDoc = async () => {
        const q = new URLSearchParams({ key });
        if (file) q.set('file', String(file));
        if (pages) q.set('pages', String(pages));
        return agentApi(\`/api/socialV2/document-images?\${q.toString()}\`, { headers, timeoutMs: 180000 });
      };
      const callText = async () => {
        const q = new URLSearchParams({ key });
        if (file) q.set('file', String(file));
        if (from != null) q.set('from', String(from));
        if (to != null) q.set('to', String(to));
        if (keyword) q.set('keyword', String(keyword));
        if (maxChars != null) q.set('maxChars', String(maxChars));
        return agentApi(\`/api/socialV2/file-text?\${q.toString()}\`, { headers, timeoutMs: 120000 });
      };
      try {
        // 都没指定时：先当文本文件试（她说"看某段"多半是文本），没有文本文件再试文档
        let mode = wantDoc ? 'doc' : (wantText ? 'text' : 'auto');
        let data;
        if (mode === 'doc') data = await callDoc();
        else if (mode === 'text') data = await callText();
        else {
          data = await callText();
          if (!data?.section && !data?.matches && /没有可分段读的文本文件|没找到叫/.test(String(data?.note ?? ''))) {
            data = await callDoc();
            mode = 'doc';
          }
        }
        const isDocResult = Array.isArray(data?.images) && (mode === 'doc' || data.images.length > 0);
        const head = isDocResult
          ? \`文档「\${data?.file ?? file ?? '最近那份'}」\${data?.totalPages ? \`（共 \${data.totalPages} 页）\` : ''}\`
            + \`\${data?.pages?.length ? \`，你要的第 \${data.pages.join('、')} 页\` : ''}\`
          : \`文件「\${data?.file ?? file ?? '最近那个'}」\`
            + \`\${data?.totalLines ? \` 共 \${data.totalLines} 行 / \${data.totalChars} 字符\` : ''}\`
            + \`\${data?.encoding ? \`（编码 \${data.encoding}）\` : ''}\`;
        const parts = [head];
        if (isDocResult) {
          const pt = data?.pageTexts ?? {};
          for (const n of Object.keys(pt).sort((a, b) => Number(a) - Number(b))) parts.push(\`\\n── 第 \${n} 页文字 ──\\n\${pt[n]}\`);
          const imgs = Array.isArray(data?.images) ? data.images : [];
          if (imgs.length) parts.push(\`\\n── 下面是这 \${imgs.length} 张图（第 \${imgs.map((i) => i.slide || '?').join('、')} 页）──\`);
        } else if (Array.isArray(data?.matches)) {
          if (data.matches.length) {
            parts.push(\`「\${data.keyword}」命中 \${data.matches.length} 处：\`);
            for (const m of data.matches) parts.push(\`── 第 \${m.line} 行（\${m.from}~\${m.to}）──\\n\${m.text}\`);
          }
        } else if (data?.section) {
          parts.push(\`── 第 \${data.from}~\${data.to} 行 ──\\n\${data.section}\`);
        }
        if (data?.note) parts.push(\`\\n（\${data.note}）\`);
        const content = [{ type: 'text', text: parts.join('\\n') }];
        for (const img of isDocResult ? (data?.images ?? []) : []) {
          if (img?.data && img?.mimeType) content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: \`看文件失败：\${error?.message ?? error}\` }], isError: true };
      }
    }
  );
}

`;

s = s.slice(0, START) + MERGED + s.slice(END);
fs.writeFileSync(F, s, 'utf8');
console.log('✅ 已把两个文件工具合并成 qq_read_file');

// Migrate existing per-conversation memory into the shared coreMemory store,
// tagging each entry with its source so the privacy filter can work:
//   private:* -> source "owner"   (never injected into groups)
//   group:*   -> source "group:<id>"
import fs from 'node:fs';

const file = 'D:/qq-bridge/state/social-v2.json';
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
s.coreMemory = s.coreMemory ?? { activeTopics: [], pendingThoughts: [], memberImpressions: {} };
const cm = s.coreMemory;

const sourceOf = (key) => (key.startsWith('private:') ? 'owner' : `group:${key.slice(6)}`);

// 备份
fs.copyFileSync(file, `${file}.bak-before-core-memory`);
console.log('备份:', `${file}.bak-before-core-memory`);

let moved = 0;
const seenTopic = new Set(cm.activeTopics.map((t) => t.text));
const seenThought = new Set(cm.pendingThoughts.map((t) => t.text));

for (const [key, conv] of Object.entries(s.conversations ?? {})) {
  const src = sourceOf(key);
  for (const t of conv.activeTopics ?? []) {
    if (!t?.text || seenTopic.has(t.text)) continue;
    seenTopic.add(t.text);
    cm.activeTopics.push({ ...t, source: src });
    moved++;
  }
  for (const t of conv.pendingThoughts ?? []) {
    if (!t?.text || seenThought.has(t.text)) continue;
    seenThought.add(t.text);
    cm.pendingThoughts.push({ ...t, source: src });
    moved++;
  }
  for (const [name, im] of Object.entries(conv.memberImpressions ?? {})) {
    if (!im || typeof im !== 'object') continue;
    const prev = cm.memberImpressions[name] ?? { traits: [], interactionCount: 0, source: src };
    const traits = new Set([...(prev.traits ?? []), ...(im.traits ?? [])]);
    cm.memberImpressions[name] = {
      ...prev,
      traits: [...traits].slice(0, 10),
      interactionCount: Math.max(Number(prev.interactionCount) || 0, Number(im.interactionCount) || 0),
      lastSeenAt: Math.max(Number(prev.lastSeenAt) || 0, Number(im.lastSeenAt) || 0),
      source: prev.source || src,
    };
    moved++;
  }
}

fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, 'utf8');

console.log(`\n迁移条目: ${moved}`);
console.log('\n=== coreMemory 现状 ===');
for (const t of cm.activeTopics) console.log(`  [话题][${t.source}] ${t.text}`);
for (const t of cm.pendingThoughts) console.log(`  [想法][${t.source}] ${t.text}`);
for (const [n, im] of Object.entries(cm.memberImpressions)) console.log(`  [印象][${im.source}] ${n}: ${(im.traits ?? []).join('、')}（互动 ${im.interactionCount} 次）`);

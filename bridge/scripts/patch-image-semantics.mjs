// Patch the qq_get_message_images MCP tool so the model is told WHAT it is
// looking at: a QQ sticker is an emotional expression, not a photo to describe.
// Text-only edits, applied by exact string replacement with verification.
import fs from 'node:fs';

const p = 'D:/qq-bridge/src/mcp-snowluma-safe.js';
let src = fs.readFileSync(p, 'utf8');
const before = src;

// 1) label per image: distinguish sticker / QQ emoji / photo, surface QQ's summary
const oldLabel = "            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);";
const newLabel = "            textParts.push(`[${img.kind === 'sticker' ? '表情包' : img.kind === 'face' ? 'QQ表情' : '图片'}${img.index ?? ''}${img.summary ? ' ' + img.summary : ''}${img.text ? ' ' + img.text : ''}]`);";
if (!src.includes(oldLabel)) throw new Error('label line not found');
src = src.replace(oldLabel, newLabel);

// 2) header: teach the model how to READ a sticker, not how to describe it
const STICKER_HINT = '【表情包】标记为「表情包」的是对方发出的贴图，属于情绪表达/反应，不是让你描述的照片。请理解它表达的情绪（无语、气鼓鼓、笑、无奈、撒娇、摆手……），结合上文语境回应——那才是对方发它的意思。通常回一个情绪对等的短句，或用 qq_send_sticker 回一张表情；不要描述画面里画了什么、人物长什么样、什么颜色头发，那等于没接话。';

const oldHeader = "          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\\n${textParts.join('\\n')}` });";
const newHeader = [
  "          // 表情包是情绪表达，不是一张图：必须显式告知模型，否则视觉模型会去",
  "          // 描述画面（“绿毛小姑娘气鼓鼓”），而不是回应对方在表达的情绪。",
  "          const hasSticker = images.some((i) => i?.kind === 'sticker');",
  `          const hint = hasSticker ? ${JSON.stringify(STICKER_HINT)} : '以下是消息里的图片内容，可以自然回应。';`,
  "          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\\n${textParts.join('\\n')}\\n\\n${hint}` });",
].join('\n');
if (!src.includes(oldHeader)) throw new Error('header line not found');
src = src.replace(oldHeader, newHeader);

if (src === before) throw new Error('no change applied');
fs.writeFileSync(p, src, 'utf8');
console.log('patched:', p);
console.log('bytes:', before.length, '->', src.length);

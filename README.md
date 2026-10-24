# her-room

一个跑在 DSH 上的 QQ 机器人，做成了桌面应用的样子。

## 这是什么

把 AI 塞进 QQ。跟普通聊天机器人不太一样：

- 有自己的人设
- 记得你说过的话
- 每天写日记
- 有情绪值
- 会主动找你说话

整个应用就是一个窗口，像 QQ/微信。后台那些服务（网关、AI、桥接）全藏着，看不到。

所有数据都在本地，不上传。

## 怎么用

1. 下载 `her-room-1.0.0-win.zip`（Releases 页面）
2. 解压
3. 双击 `app\QQAI.exe`
4. 按向导填：目录 / QQ 号 / 人格名 / API Key
5. 完事

需要 Windows、Node.js 20+、装好的 QQ（NT 版）。

## 里面有什么

```
app/      桌面应用
napcat/   QQ 网关（内置）
bridge/   桥接（记忆/日记/情绪/工具）
```

## 许可

个人学习自用，别商用。

内置的 NapCat 有自己的许可（见 `napcat/LICENSE`），同样禁止商用。

## 免责

非官方 QQ 客户端，封号风险自负。

## 致谢

- [NapCat](https://github.com/NapNeko/NapCatQQ)
- [DSH](https://github.com/deepseek-ai)

# her-room · 她的房间

> 一个住在你电脑里的 AI，用 QQ 跟你聊天。
> 不是工具，不是客服——是一个有记忆、有日记、有脾气的“人”。

![界面预览](docs/preview.png)

## 这是什么

一个桌面应用（Electron）+ 本地后台服务，把“一个 AI 住在 QQ 里”这件事做成一个**像 QQ/微信一样**的窗口：

- 你双击打开，桌面只有一个窗口
- 她在里面：聊天、记得你说过的话、每天写日记、有自己的情绪
- 所有数据都在你本地（记忆、日记、情绪），不上传任何地方

## 为什么叫“她的房间”

因为这个应用不是“一个机器人控制台”，而是**她的房间**：

| 房间里的东西 | 功能 |
|---|---|
| 客厅 | 聊天（私聊/群聊） |
| 抽屉 | 记忆（她记得的事） |
| 日记本 | 她每天写的 |
| 心情墙 | 情绪值 |
| 工具箱 | 她能用的工具（按环境启用） |
| 电闸 | 控制台（静默/唤醒/白名单） |

## 快速开始

1. 下载 `her-room-1.0.0-win.zip`（Releases）
2. 解压到任意目录
3. 双击 `app\QQAI.exe`
4. 首次向导：目录 / QQ 号 / 人格名 / API Key
5. 保存 → 自动启动（NapCat 快速登录；需要时显示扫码）

**需要**：Windows 10/11、Node.js ≥ 20、腾讯 QQ（NT）

## 结构

```
her-room/
  ├─ app/         桌面应用
  ├─ napcat/      网关（内置）
  ├─ bridge/      桥接（记忆/情绪/日记）
  ├─ settings.example.json
  └─ README.md / LICENSE / 应急手册.md / uninstall.bat
```

## 许可

- 本项目的代码：**非商业使用许可**（见 [LICENSE](./LICENSE)）——个人学习/研究/非盈利可用，**禁止商用**
- 内置 [NapCat](https://github.com/NapNeko/NapCatQQ)：Limited Redistribution License（见 `napcat/LICENSE`）——**同样禁止商用**

## 免责

仅供学习交流。使用非官方 QQ 客户端存在账号封禁风险，由使用者承担。使用请遵守当地法律法规与腾讯 QQ 用户协议。

## 致谢

- [NapCat](https://github.com/NapNeko/NapCatQQ) — QQ 网关
- [DSH](https://github.com/deepseek-ai) — AI 引擎

如果这个房间让你觉得有点意思，欢迎 Star ⭐

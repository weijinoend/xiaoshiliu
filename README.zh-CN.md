# 小石榴

[English](README.md) | 简体中文

基于 MIT 开源聊天前端扩展的多模型 AI 客户端。纯前端静态架构，支持原生接口、OpenAI 兼容接口（Chat Completions / Responses）、本地部署模型（Ollama / LM Studio / vLLM / LocalAI），以及一键打包 Android APK。

这是具有独立品牌、包名和签名体系的小石榴个性化版本。设计理念是“外面圆圆的，里面点子很多，主打一个内涵丰富”。

## 核心功能

- **多模型与本地部署**：支持原生协议、OpenAI `/chat/completions`、OpenAI `/responses`，以及免 API Key 的本地部署协议（一键预设 Ollama / LM Studio / vLLM / LocalAI，支持在线获取模型列表）。
- **多能力独立渠道**：支持为语音识别（ASR）、语音播报（TTS）、视觉识图、文档 OCR 与文生图/图生图配置独立接口与密钥。
- **文生图与图生图**：自然语言生图、支持参考图与原图比例匹配、生图确认开关与尺寸选择。
- **连续语音通话与视觉交互**：支持语音实时通话、摄像头开启与手机前后置摄像头切换、顶栏小喇叭开启回复语音自动播报。
- **长期记忆与可控策略**：自动提取与手动编辑长期记忆、跨会话记忆召回上限可调、支持回复分支编辑与自定义用户输入关键词拒答。
- **Token 用量统计与每日提醒**：单次对话下方显示 Token 消耗，支持设置每日最大 Token 上限并在达到阈值时弹窗提醒。
- **历史记录导入导出**：兼容 `export_format_version: 3` 历史对话 ZIP 归档。
- **版本检查与更新公告**：应用内置 GitHub Releases 检查更新，展示每次发版的更新日志，用户可自主选择立即下载安装、保留当前版本或跳过该版本。

## 本地运行与部署

准备 Node.js 22+ 与 pnpm：

```sh
cd D:/Codex/DeepJeek-src
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

构建静态产物或启动独立本地托管服务（自带 `/__api_proxy__` 跨域/本地系统代理转发）：

```sh
pnpm build
pnpm preview
```

## Android 打包与自动发布

本地生成签名 Release APK：

```sh
pnpm run android:sync
cd android && ./gradlew assembleRelease
```

使用 GitHub Actions 自动编译签名 APK 并发布 Release（推荐在仓库 `Settings → Secrets and variables → Actions` 配置以下 Secret，以保证与既有版本同签名平滑覆盖升级）：

- `SIGNING_KEYSTORE_BASE64`：签名 `.keystore` 文件的 Base64 编码
- `SIGNING_KEYSTORE_PASS`（可选，默认 `android`）
- `SIGNING_KEY_ALIAS`（可选，默认 `androiddebugkey`）
- `SIGNING_KEY_PASS`（可选，默认 `android`）

推送版本标签即可自动构建并发布到 Releases（附带更新公告）：

```sh
git tag v1.0.2
git push origin v1.0.2
```

## 开源协议

[MIT License](LICENSE)

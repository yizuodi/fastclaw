# FastClaw WebChat

轻量级全栈 AI 聊天应用，包含 Node.js 后端代理 + 现代前端界面。后端通过 WebSocket 连接 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，前端提供美观的聊天体验。一个 `npm start` 即可运行。

## ✨ 功能特性

- 🔐 密码登录保护
- 🌗 明暗主题切换
- 📱 移动端适配
- 🔄 实时轮询 + 消息历史加载
- 🖼️ 图片展示（Markdown 图片 + 直接渲染）
- ⚙️ 处理过程默认隐藏，一键展开查看
- 🏷️ 品牌可自定义（名称、图标等）
- 📋 所有配置通过 `config.json` 管理

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建配置文件

```bash
cp config.example.json config.json
```

编辑 `config.json`，填入你的配置：

```json
{
  "server": {
    "port": 23456,
    "host": "0.0.0.0"
  },
  "auth": {
    "password": "你的访问密码"
  },
  "gateway": {
    "wsUrl": "ws://127.0.0.1:18789",
    "token": "你的 OpenClaw Gateway Token"
  },
  "session": {
    "key": "webchat-shared",
    "historyLimit": 500
  },
  "branding": {
    "name": "FastClaw",
    "emoji": "🐾",
    "avatarBot": "FC",
    "avatarUser": "U"
  }
}
```

### 3. 获取 Gateway Token

在你的 OpenClaw 服务器上运行：

```bash
openclaw gateway token
```

将输出的 token 填入 `config.json` 的 `gateway.token` 字段。

### 4. 启动服务

```bash
npm start
# 或指定端口
PORT=3000 npm start
```

打开浏览器访问 `http://你的IP:23456`，输入密码即可使用。

## ⚙️ 配置说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `server.port` | 监听端口 | `23456` |
| `server.host` | 监听地址 | `0.0.0.0` |
| `auth.password` | 访问密码（留空则不验证） | - |
| `gateway.wsUrl` | OpenClaw Gateway WebSocket 地址 | `ws://127.0.0.1:18789` |
| `gateway.token` | OpenClaw Gateway Token | - |
| `session.key` | 共享 Session 标识 | `webchat-shared` |
| `session.historyLimit` | 历史消息拉取上限 | `500` |
| `branding.name` | 品牌名称 | `FastClaw` |
| `branding.emoji` | Logo Emoji | `🐾` |
| `branding.avatarBot` | AI 头像文字 | `FC` |
| `branding.avatarUser` | 用户头像文字 | `U` |

环境变量优先级高于配置文件：`PORT`、`AUTH_TOKEN`、`GW_WS_URL`、`GW_TOKEN`。

## 📁 项目结构

```
fastclaw-webchat/
├── config.json            # 配置文件（不提交到 Git）
├── config.example.json    # 配置模板
├── package.json
├── server.js              # 后端服务
├── .gitignore
├── README.md
└── public/
    ├── index.html         # 页面结构
    ├── style.css          # 样式
    └── app.js             # 前端逻辑
```

## 🔒 安全注意事项

- `config.json` 和 `device-identity.json` 已在 `.gitignore` 中，不会被提交
- `device-identity.json` 是首次启动时自动生成的设备密钥，用于 Gateway 认证
- 建议使用强密码，或在前方再加一层 Nginx 反向代理 + HTTPS

## 🔄 持久化运行（PM2）

推荐使用 [PM2](https://pm2.keymetrics.io/) 让服务在后台持续运行，自动重启：

```bash
# 安装 PM2（如果没有）
npm install -g pm2

# 启动服务
pm2 start server.js --name fastclaw

# 设置开机自启
pm2 save
pm2 startup

# 常用命令
pm2 logs fastclaw     # 查看日志
pm2 restart fastclaw   # 重启
pm2 stop fastclaw      # 停止
pm2 status             # 查看状态
```

## 📄 License

MIT

# Mockoon CLI Streaming Proxy

一个基于 Node.js (>=18) 的轻量代理，用于拦截指定端口和 URL 的请求，为 Mockoon CLI 提供流式响应能力。

## 支持什么？

- ✅ 支持拦截**多个接口路径**（`interceptPaths` 数组）
- ✅ 不在拦截列表中的接口会**直接透传**到上游 Mockoon CLI（不做 SSE 拆行改写）

## 环境要求

- Node.js >= 18

## 配置方式（配置文件）

使用项目根目录下的 `config.json`：

```json
{
  "listenPort": 8080,
  "targetBaseUrl": "http://127.0.0.1:3000",
  "requestTimeoutMs": 120000,
  "interceptPaths": [
    "/v1/chat/completions"
  ]
}
```

字段说明：

- `listenPort`：本代理监听端口
- `targetBaseUrl`：Mockoon CLI 服务地址（协议+主机+端口）
- `requestTimeoutMs`：上游请求超时毫秒数
- `interceptPaths`：需要做流式改写的路径数组（可多个）

> 兼容旧字段：若你已有 `interceptPath`（单个字符串），程序也会自动兼容。

## 启动方式

```bash
npm start
```

## 请求链路示意

客户端 -> 本代理(`listenPort`) -> Mockoon CLI(`targetBaseUrl` + 原始 path/query)

- path 在 `interceptPaths`：返回 SSE 风格流式
- path 不在 `interceptPaths`：原样透传

## 流式处理逻辑（仅拦截路径生效）

上游返回示例：

```text
data: {...}

data: {...}

data: [DONE]
```

本代理会：

- 按 `\n` 或 `\r\n` 分行解析
- 忽略空行
- 每行即时写回（补 `\n\n`），保证客户端持续收到分批响应

## 内网离线部署建议

如果内网无法联网安装依赖：

本项目**无第三方依赖**，只使用 Node.js 内置模块，因此离线部署非常简单。

### 方案 A：直接拷贝源码（推荐）

1. 在外网准备目录，包含以下文件：
   - `package.json`
   - `config.json`
   - `src/index.js`
   - `README.md`
2. 将整个目录打包：
   ```bash
   tar -czf mockoon-cli-proxy.tar.gz Mockoon-cli-proxy/
   ```
3. 拷贝到内网并解压：
   ```bash
   tar -xzf mockoon-cli-proxy.tar.gz
   cd Mockoon-cli-proxy
   ```
4. 修改 `config.json` 为内网实际地址。
5. 直接启动（无需 `npm install`）：
   ```bash
   npm start
   ```



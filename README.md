# Mockoon CLI Streaming Proxy

一个基于 Node.js (>=18) 的轻量代理，用于将请求转发到一个或多个 Mockoon（或其他上游）服务，并可对指定接口做 SSE 风格流式输出。

## 支持什么？

- ✅ 支持配置**多个 targetBaseUrl**（`routes`）
- ✅ 支持按路径前缀把请求路由到不同上游
- ✅ 支持为拦截路径输出 SSE 风格响应
- ✅ 支持配置流式输出的模拟延迟（`streamDelayMs`）
- ✅ 支持后台常驻运行并写日志（`npm run start:daemon`）

## 环境要求

- Node.js >= 18

## 配置方式（配置文件）

使用项目根目录下的 `config.json`：

```json
{
  "listenPort": 8080,
  "requestTimeoutMs": 120000,
  "streamDelayMs": 120,
  "routes": [
    {
      "targetBaseUrl": "http://127.0.0.1:3000",
      "matchPaths": ["/v1"],
      "interceptPaths": ["/v1/chat/completions"]
    },
    {
      "targetBaseUrl": "http://127.0.0.1:4000",
      "matchPaths": ["/api"],
      "interceptPaths": []
    },
    {
      "targetBaseUrl": "http://127.0.0.1:3000",
      "matchPaths": ["/"],
      "interceptPaths": []
    }
  ]
}
```

字段说明：

- `listenPort`：代理监听端口
- `requestTimeoutMs`：上游请求超时毫秒数
- `streamDelayMs`：拦截路径下，逐行输出的间隔毫秒数（0 表示无延迟）
- `routes`：路由规则数组
  - `targetBaseUrl`：该路由对应上游地址（协议+主机+端口）
  - `matchPaths`：路径前缀匹配列表，命中该前缀时走这条路由（最长前缀优先）
  - `interceptPaths`：该上游下需要转为 SSE 风格输出的完整路径列表

> 兼容旧配置：若未配置 `routes`，仍可使用单个 `targetBaseUrl + interceptPaths/interceptPath`。

## 启动方式

前台运行：

```bash
npm start
```

后台常驻（关闭终端不退出）：

```bash
npm run start:daemon
# 或
bash scripts/start.sh
```

停止后台进程：

```bash
npm run stop:daemon
# 或
bash scripts/stop.sh
```

日志文件：

- `logs/proxy.out.log`：标准输出和错误输出
- `logs/proxy.pid`：进程 PID

## 如何确认浏览器端“真流式”

1. 请求路径必须在命中路由的 `interceptPaths` 中。
2. 响应头会被设置为：
   - `content-type: text/event-stream`
   - `cache-control: no-cache, no-transform`
   - `x-accel-buffering: no`
3. 建议用下面命令验证是否分段到达：

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions
```

如果输出是按行逐步出现（且有间隔），说明代理端确实是流式输出。

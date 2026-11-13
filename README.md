# dsh-web-search-searxng

把自建 [SearXNG](https://searxng.org/) 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `web_search` 上。

**276 行有效代码 · 零依赖 · 不锁定 DSH 版本 · MIT**

---

## 为什么又写一个？

**不是重复造轮子 —— 是现有的轮子装不上车。**

写之前我们把 npm 上 6 个 DSH 搜索插件的源码全部下载下来读了一遍：

| 插件 | JS 总行数¹ | 依赖 | 能装到 DSH `0.2.2-rc.3`？ | 支持 SearXNG？ |
|---|---:|---|---|---|
| `dsh-web-search-brave` | 265 | 4 peer | ❌ 钉死 `0.2.2-rc.1` | ❌ 只有 Brave |
| `@240xu/dsh-websearch` | 5,614 | 6 peer | ✅ peer 全为 `*` | ✅ 但默认指向公共实例 `searx.be` |
| `@lemoncat7/dsh-web-search` | 2,524 | `undici` + schemastery | ❌ `=rc.1 \|\| =rc.2` | ✅ |
| `dsh-web-search-thirdparty` | 1,921 | schemastery | ❌ `^0.1.0-rc.6` | ✅ |
| `dsh-web-search-diy` | 11,676 | 5 peer | ✅ | ❌ |
| `@tnnevol/dsh-failover-search` | 42,759 | 19 peer | ❌ 钉死 `0.2.2-rc.1` | ❌ |

<sub>¹ 含客户端 UI、设置面板、多后端适配层，不是纯 provider 代码。</sub>

结论很尴尬：

- **能装上的**，要么不支持 SearXNG，要么默认连公共实例（随时挂、JSON 常被禁）
- **支持 SearXNG 的**，装不上 —— 它们把 `@deepseek-ai/dsh-web` 钉死在某个 rc 版本上
- **既能装又支持 SearXNG 的**，为了 11 个后端背了 5600 行，其中大部分是设置 UI 和熔断/健康检查框架

所以这个项目只做一件事：**把 SearXNG 接到 `ctx.web`**，并且做到「DSH 升级多少次都不用管」。

---

## 核心优势

### 1. 不锁定 DSH 版本

这是最重要的差异。

DSH 的插件兼容性检查看两处：`peerDependencies` 里的 `@deepseek-ai/*` 版本，和 `engines.dsh`。第三方搜索插件几乎全部钉死：

```jsonc
// dsh-web-search-brave@0.2.5
"peerDependencies": { "@deepseek-ai/dsh-web": "0.2.2-rc.1" },
"engines": { "dsh": "0.2.2-rc.1" }

// @lemoncat7/dsh-web-search@0.3.7
"engines": { "dsh": "=0.2.2-rc.1 || =0.2.2-rc.2" }
```

结果是 DSH 从 `rc.1` 升到 `rc.3`，它们就全部失效，用户要么等作者更新，要么手动打「版本豁免」承担崩溃风险。

**本项目的做法：一个 `@deepseek-ai/*` 都不 import。**

```jsonc
// package.json —— 没有 dependencies，没有 peerDependencies，没有 engines.dsh
{
  "name": "dsh-web-search-searxng",
  "type": "module",
  "main": "index.js"
}
```

插件只使用平台能力（`fetch`、`AbortSignal`、`URL`），`index.js` 里连 `import` 语句都没有一条。所以：

- DSH `0.2.2-rc.3` → `0.2.2` → `0.3` → `0.4`，**不需要改一行代码**
- 安装时**不会出现任何兼容性警告**，不需要 `dsh plugin allow-version` 豁免

> 实测：同一次安装里，`@deepseek-ai/dsh-subagent-codex@0.2.2-rc.2` 因为钉死版本被 DSH 拒绝加载并提示需要豁免，而本插件零警告通过。

### 2. 零依赖

没有 `undici`，没有 `schemastery`，没有 `zod`，没有任何运行时依赖。

- 安装体积：**约 23 KB**
- 供应链攻击面：**0 个第三方包**
- 不会因为某个传递依赖被删/被改而挂掉

### 3. 只做一件事

不试图支持 11 个后端，不做熔断器、不做多实例轮询、不做用量统计面板。

一个 provider，一个配置文件，276 行。你想改逻辑，五分钟能读完。

### 4. 把别人漏掉的细节补上

读源码时发现的共同缺陷，这里都处理了：

| 问题 | 其他插件 | 本项目 |
|---|---|---|
| **`content` 里的 HTML** | 直接截 500 字符或原样透传，模型看到 `<b>` 和 `&amp;` | 去标签 + 解码实体 + 压空白 |
| **`publishedDate` 时区** | 直接 `Date.parse`，按**本机时区**解释，换台机器日期就漂 | naive datetime 一律按 UTC 归一 |
| **HTTP 200 ≠ 成功** | 公共实例会返回反爬 HTML 页面（状态码 200），被当成正常响应 | 语义健康检查，识别反爬页并报「实例降级」 |
| **`unresponsive_engines`** | 完全忽略，引擎被 CAPTCHA 停用 7 天也看不出来 | `debug: true` 时输出到日志 |
| **错误信息** | `fetch failed` / `HTTP 403`，看不出该改什么 | 403 直接提示「是不是 `search.formats` 没开 json / limiter 拦了」；连接失败带 `ECONNREFUSED` |
| **并发** | 一次 `web_search` 最多 10 个 query 全并发打过去 | 默认并发 2，避免把上游引擎打到限流 |
| **重复查询** | 每轮对话重复搜同一件事 | 60 秒 TTL 缓存 |

---

## 安装

```sh
dsh plugin --profile <profile> add github:vinsec/dsh-web-search-searxng
```

然后在 **插件 → 内置插件设置 → 网页搜索与获取** 的 Search 菜单里选 **SearXNG**，或者直接钉在 profile 的补丁层：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: web
  config:
    searchProvider: searxng
    fetchProvider: http      # 保留免费的本机抓取
```

重启 DSH 生效。

---

## 配置

第三方 provider 在设置页没有表单，配置写在 profile 的补丁层：

```yaml
- id: web-search-searxng
  name: 'dsh-web-search-searxng'
  config:
    baseURL: http://127.0.0.1:8080
    language: zh-CN
    engines: [google cse, startpage, mojeek]
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | **必填** | 实例根地址，如 `http://127.0.0.1:8080`。支持路径前缀：`https://host/searxng` → `https://host/searxng/search`。必须是绝对 http(s) URL，不能内嵌凭据 |
| `token` | `''` | 作为 `Authorization: Bearer <token>` 发送。SearXNG 本身无鉴权，前置反向代理需要时用 |
| `language` | `''`（自动） | 传给 `language`，如 `zh-CN`、`en` |
| `engines` | `[]`（实例默认） | 逗号拼接的 `engines` 过滤。引擎越少延迟越低 |
| `categories` | `general` | 传给 `categories` |
| `safesearch` | `1` | `0` 无 / `1` 中等 / `2` 严格 |
| `timeoutMs` | `20000` | 单次请求超时。SearXNG 要并发打多个引擎，别设太短 |
| `maxResults` | `10` | 调用方未指定时的兜底上限 |
| `cacheTtlMs` | `60000` | 相同 query + 上限的缓存时间，`0` 关闭 |
| `cacheEntries` | `100` | 缓存条目上限 |
| `maxConcurrency` | `2` | 并发上游请求数 |
| `debug` | `false` | 输出 `unresponsive_engines` 到宿主日志 |

---

## SearXNG 侧要求

```yaml
# /etc/searxng/settings.yml
use_default_settings: true

server:
  limiter: false          # 关键：否则程序化调用会被 bot 检测拦成 403
  secret_key: "<随机字符串>"

search:
  formats:
    - html
    - json              # 关键：不加这行，API 直接 403
```

**不要把实例暴露到公网。** SearXNG 自身没有任何鉴权。用 Tailscale / WireGuard，或者在前面加一层带 Bearer token 的反向代理（并把 token 填到 `token` 字段）。

验证：

```sh
curl -s 'http://127.0.0.1:8080/search?q=test&format=json' | jq '.results[0]'
curl -s 'http://127.0.0.1:8080/search?q=test&format=json' | jq '.unresponsive_engines'
```

---

## 排障

| 现象 | 原因 |
|---|---|
| `HTTP 403 — is search.formats missing json…` | `search.formats` 里没有 `json` |
| `HTTP 429 — the SearXNG limiter is throttling…` | `server.limiter` 开着，关掉或把来源加入白名单 |
| `answered HTTP 200 with an HTML/anti-bot page` | 实例前面有反爬墙，或 `baseURL` 指向了代理而不是 SearXNG |
| `response has no results[] array` | `baseURL` 指到了非 SearXNG API 的地址 |
| `fetch failed (ECONNREFUSED)` | 实例没起，或端口/地址不对 |
| 浏览器能搜，DSH 搜不到 | 上游引擎全部被 CAPTCHA 停用，看 `.unresponsive_engines` 和 SearXNG 日志 |
| `baseURL is missing or invalid` | 不是绝对 http(s) URL，或内嵌了凭据 |

---

## 开发

```sh
node test/harness.mjs
```

13 个用例跑在 mock 实例上（真实 HTTP，不是 mock 函数）：字段映射、去重、HTML 清洗、日期归一、路径前缀、缓存、403/429/反爬/协议错误、空结果、取消、超时、非法 baseURL、连接被拒、并发上限。

---

## License

MIT © vinsec

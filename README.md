# Epic / Fab 免费领取助手

单文件 Tampermonkey 用户脚本：打开浏览器时自动扫 Epic 本周免费游戏、Fab 免费资产，能领的直接领。
跑在你自己浏览器的页面里 —— 不用服务器、不碰密码、不搬 cookie。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Firefox 可用 Violentmonkey）
2. 点这里安装：[**epic-fab-claimer.user.js**](https://raw.githubusercontent.com/LHuiMeng/epic-fab-claimer-userscript/main/epic-fab-claimer.user.js)
3. 先在浏览器里登录一次 Epic 和 Fab —— 脚本只用你已有的登录态

> 脚本自带 `@updateURL`，作者推新版后 Tampermonkey 会自动更新（默认每 24 小时查一次，
> 也可在扩展设置里把「检查更新」间隔调小）。手动更新：Tampermonkey 面板 → 本脚本 → 检查更新。

## 它什么时候跑（v1.3.0：打开浏览器就干活）

**不用先打开 Epic 或 Fab** —— 每天第一次落到任意网页，脚本就开始工作：

| 场景 | 行为 |
|---|---|
| 每天第一次打开浏览器（任意网站都算） | 后台静默开两个标签：Epic 免费游戏 + Fab 限时免费，扫完自己关；结果用右下角悬浮窗汇报 |
| 打开任何 Epic 商城页 | 扫本周免费游戏，有可领的在后台开领取标签 |
| 打开任何 Fab 页面 | 同源接口直接领免费 / 限时免费资产 |
| 领取标签页 | 自动点「下单 / 添加到库」→ 过条款 → 等结果；弹真人验证就高亮该标签并弹通知，停在那里等你点 |

右下角悬浮面板：本轮状态、「立即扫描本轮」（强制重试失败项）、「清日志」、最近 24 条日志。

### 结果悬浮窗（不打扰你）

- 位置在右下角，只有它自己那块区域吃点击，**不遮页面、不弹模态、不抢焦点**
- 领到了 → 「Fab：领到 N 个」+ 标题
- 早就在库里 → 「Fab：M 个早就在库里（领过了）」，跟「没领到」分开说清楚
- 有失败 → 红字点名 + 一条系统通知
- 点右上角 **✕ = 今天不再提醒**（第二天自动恢复）；同一天最多主动弹 3 次，不会每开一个标签页就糊一次

## 许可策略：专业版优先（v1.1.1）

Fab 的同一个资产常常同时挂**个人（Personal）**和**专业（Professional）**两档免费授权。
脚本的选择顺序是：

1. 免费的**专业版**优先
2. 专业版要钱（价格 ≠ 0）→ 退而领免费的个人版
3. 只有 CC-BY 等其它免费授权 → 领它

实测坑：Fab 返回的档位名是**本地化**的 —— 中文环境是 `专业` / `个人`，英文环境是
`Professional` / `Personal`。只按英文名匹配排序会全部失效，结果每次都领到数组里靠前的个人版
（这个 bug 真发生过，v1.1.1 修的就是它）。脚本现在两种语言都认。

已经用个人版领过的资产，下次扫描会额外查一次「专业版现在免费了吗」：免费就补领专业版，
仍要钱就记个时间戳、`retryDays` 天内不再问。

## 限时免费（100% 折扣）走 0 元购物车（v1.3.0）

Fab 的免费有两类，长得完全不一样：

| 类型 | 特征 | 领取方式 |
|---|---|---|
| 永久免费 | `priceTier.price === 0` | `POST /i/listings/{id}/add-to-library` |
| **限时免费** | `price` 是原价，`discountedPrice === 0`、`effectiveDiscountPercentage === 100`，带起止时间 | add-to-library 一律回 `400 Not free.` → 必须**走购物车结算** |

所以脚本现在：

1. 列表两条口子都捞：`min_discount_percentage=100`（限时免费**只在这条里出现**，`is_free=1` 搜不到它）+ `is_free=1`
2. 判断免费用 `freeUntilOf()`：永久免费 or 「现在落在折扣窗口内」，过期的、没开始的都不算
3. add-to-library 回 `Not free` 时自动改走：加购 → 读 `totalPrice.discountPrice` → **不是 0 就撤单** → `validate` → `finalize`
4. 全程只要有一处金额不是 0，立即 `DELETE` 撤掉购物车里的条目，绝不动钱

## 「领过了」怎么确认（不是靠猜）

`add-to-library` 对**已拥有**的条目照样回 204，加购物车也回 201 —— 这两个都不能当判据。

真正管用的是 Fab 库自己的搜索接口：

```
GET /i/library/search?q=<标题片段>&count=10   → 200 { results: [ { listing: { title } } ] }
```

命中就把条目记 `verified: true` 并算作「早就在库里」。拿不到结果（未登录 / 网络问题）时
**不会**冒充证据，只记「本轮没验到」。

> 别用整页 `/library` 去扫：它只渲染第一页（约 48 条），早先领过的条目扫不到，
> 会让人以为「没领过」而去重复下单（这个坑踩过）。

## 三道安全闸（防止在你账号上下错单）

1. 只处理免费接口返回的条目
2. 点之前校验页面价格：明确读到非 0 金额 → 直接放弃；读不到价格 → 只在按钮文案确实是领取类时才继续
3. 每轮 Epic 最多开 3 个、Fab 最多领 10 个；失败条目按冷却重试（Epic 120 分钟 / Fab 7 天）

## 不存任何敏感信息

- 脚本里**不含**任何 token、cookie、账号 ID、密码；仓库里也没有（本 README 就是完整说明）
- 登录态完全由浏览器自己管；需要 CSRF 时从当前页 cookie **实时读取**，读完即用，不落盘
- 本地只存两类东西：领取历史（条目标题 / 状态 / 所选档位 / 时间戳），和一条最多 200 行的运行日志
- 位置：Tampermonkey 沙箱存储的 `efc:*` 键。想清空 → 面板「清日志」，或扩展里删掉这些键

## 设置项（`efc:settings`）

```js
{ autoEpic: true,      // 每日自动扫 Epic
  autoFab: true,       // 打开 Fab 自动领
  maxEpicPerRun: 3,    // 每轮最多开几个 Epic 领取页
  maxFabPerRun: 10,    // 每轮最多领几个 Fab 资产
  retryDays: 7,        // Fab 失败条目几天内不重试
  epicRetryMinutes: 120, // Epic 没领到的条目多久重试一次（限时免费只有一周，别睡七天）
  dryRun: false,       // true = 只扫描不领取
  epicScanHours: 24,
  fabScanHours: 6 }
```

改法：Tampermonkey 面板 → 本脚本 → 「存储」标签 → `efc:settings`。

## 限时免费的条目不会被静默丢掉（v1.2.0）

Epic 的免费游戏只有一周窗口，所以脚本对「没领到」的态度是**反复重试**，不是记一笔就睡七天：

- 领取成功的判据收紧成两条硬证据 → 订单完成文案（`Thanks for your order` / `感谢您的订单` / `下单成功`），
  或结账页按钮变成 `In Library` / `已在库`
- 成功时记 `verified: true`；历史里那些**没有 `verified` 标记的 `claimed`** 一律当作待复核，下次自动重开一遍
  （旧版把结账页常驻的 “Download the Epic Games Launcher” 文案当成成功了，于是限时免费的条目再也没碰过）
- 其它状态（`failed` / `needs-human` / `needs-login` / `skipped-paid`）按 `epicRetryMinutes`（默认 120 分钟）重试
- 免费窗口 48 小时内到期还没领到 → 顶部横幅 + 系统通知点名，不会让你以为已经处理好了
- 每条被跳过的都会在面板写清原因和「还有几分钟重试」

## 出问题怎么定位

面板日志会写出卡在哪一步：

- `Epic：60 秒没等到领取按钮（选择器可能又变了）` → Epic 改版了，提 issue 带截图，作者改 `SEL` 常量
- `Epic：页面要求登录` → 重新登录一次 Epic
- `Fab：未登录（/i/users/me → 401）` → 浏览器里的 Fab 会话没登录或过期，去 fab.com 登录一次
- `Fab：CSRF 被拒（403）` → cookie 刚刷新，脚本会等 1.5 秒重试

### Fab 的 401 与 403 不是一回事（实测对照）

同一个 `add-to-library` 请求，同一会话做了四组对照：

| 请求 | 结果 |
|---|---|
| 带正确 `X-CsrfToken` | **204** 领取成功 |
| 不带 csrf 头 | **403** `{"detail":"CSRF Failed: CSRF token missing."}` |
| 带错的 csrf | **403** `{"detail":"...CSRF token from the 'X-Csrftoken' HTTP header has incorrect length."}` |
| 会话未登录 | **401** |

所以 401 = **登录态**问题，不是 CSRF。而且 `/i/listings/search` 是公开接口，未登录也能列出免费资产，
只在写操作才 401 —— 这就是「列表拿到了、领取全失败」看起来像脚本 bug 的原因。

脚本的处理：先 `GET /i/users/me` 确认登录（未登录直接提示，不拿条目一个个撞 401）；
真撞到 401 立刻停手记 `needs-login`，登录后下次开页面自动接着领。

## 本地自测

```bash
node --check epic-fab-claimer.user.js
node test_logic.mjs     # 用 free_sample.json（真实接口快照）验免费判定、价格闸、档位排序
```

`test_logic.mjs` 用 `vm` 把脚本丢进沙箱、跳过 boot，只测纯函数：
`freeWindow`（免费窗口三层遍历）、`priceIsZero`（5 组真实文案）、`claimUrlFor`（结账 URL 三元组）、
`tierRank`（专业/个人/CC-BY 排序）。

## 已知边界

- Epic 的真人验证（hCaptcha / Turnstile）没有可编程解法，脚本只能高亮 + 通知，需要你点一下
- Fab 的 `add-to-library` 对「已拥有」也回 204，HTTP 码无法区分首次/重复，去重只能靠本地历史
- Epic 结账页的真实 DOM 依赖社区反馈修正（作者侧一开自动化浏览器就被 Turnstile 拦）

## License

MIT

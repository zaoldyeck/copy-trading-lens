# Copy Trading Lens

[English](README.md) | [台灣正體中文](README.zh-TW.md) | 简体中文 | [日本語](README.ja.md)

Copy Trading Lens 是一个 Chrome Extension，用来在 Binance / OKX 个别跟单员页面上，实时分析该带单员的跟单风险。

它不是交易机器人，不会帮你下单，也不保证收益。它的目标是把跟单前最容易忽略的风险摊开来：类马丁格尔仓位、网格/区间交易、逆势加仓、补保证金、死扛浮亏、高频微利滑价、盈亏比失衡、跟单者实际体验背离。

## 核心特性

- 支持 Binance 跟单员页面：`/copy-trading/lead-details/<portfolioId>`
- 支持 OKX 跟单员页面：`/copy-trading/account/<uniqueName>`
- 进入个别带单员页面后自动分析
- 不使用静态带单员推荐名单
- 每次都从当前页面重新抓取同站、当前 session 可见的最新数据
- Binance 主绩效优先由当下抓到的历史交易、转账记录与当前带单资金重建
- 显示全期间年化收益；有现金流数据时用 XIRR/APY，否则用全期间 ROI 与经过天数推估 CAGR
- Binance 历史分页遇到系统忙碌、网络抖动、429/5xx 等暂时错误时会持续重试，直到抓完目标数据
- 只在你的浏览器本机运算
- 没有后端服务、analytics、remote code、cookie/header/API key 储存，也不会上传账户数据
- 显示可解释证据，而不是只给黑盒分数
- 支持 Chrome extension locale：英文、台湾繁体中文、简体中文、日文

## 分析内容

Extension 会根据当前页面实时能取得的数据，检查：

- 全期间 ROI / 年化收益 / 全期间 PnL / MDD / 交易天数 / 跟单者 PnL/AUM
- Binance 7D / 30D / 90D / 180D / 365D 交易所时间窗交叉检查
- 胜率、平均获利、平均亏损、盈亏比、每笔期望值
- 获利单与亏损单持仓时间
- 历史订单中的逆势加仓、分层、最大层数、订单名义金额型态、高频拆单特征
- 转账记录中是否有亏损持仓期间资金转入
- 当前持仓是否有明显浮亏或高曝险
- 高频微利策略是否可能被跟单延迟、滑价、最小下单量与手续费吃掉

## 策略标签

面板会使用跟单者熟悉的交易风格词汇，让风险更容易判断：

- **马丁格尔**：亏损时加大仓位，连续错边会快速放大回撤。
- **网格 / 区间交易**：分层挂单吃震荡，单边行情容易累积浮亏。
- **DCA / 左侧交易**：逆势分批摊平，太早跟进可能承接回撤。
- **右侧交易 / 趋势跟随**：方向确认后进场，通常更依赖干净止损。
- **剥头皮**：短线高频小利，跟单延迟、最小下单量、手续费、滑价都很重要。
- **做市倾向**：大量短线成交，跟单执行质量可能吃掉优势。
- **波段交易**：持仓时间较长，跟单者可能承接既有持仓波动。

## Chrome Web Store 上架前安装

在 extension 还没上架 Chrome Web Store 之前，请先从 GitHub Releases 安装：

1. 打开 GitHub 最新 release。
2. 下载 `copy-trading-lens-<version>.zip`。
3. 解压缩到本机文件夹。
4. 打开 `chrome://extensions`。
5. 开启 **Developer mode**。
6. 点 **Load unpacked**。
7. 选择解压缩后的文件夹。
8. 打开 Binance 或 OKX 的个别跟单员页面。

## 从源代码构建

```bash
npm run package
```

然后在 Chrome：

1. 打开 `chrome://extensions`
2. 开启 **Developer mode**
3. 点 **Load unpacked**
4. 选择这个 repository 文件夹，或选择 `dist/copy-trading-lens/`
5. 打开 Binance 或 OKX 的个别跟单员页面

## 项目目录

```text
.
├── _locales/        Chrome i18n 消息文件
├── assets/icons/    Extension icons
├── openspec/        公开产品与打包规格
├── scripts/         验证、icon 生成、打包脚本
├── src/             Provider adapters、分析引擎、content UI、popup 程序
├── manifest.json    Chrome Manifest V3 定义
├── popup.html       Extension action popup
├── PRIVACY.md       隐私政策
└── README*.md       用户与开发者文档
```

## 权限说明

Manifest 只要求：

- `https://www.binance.com/*`
- `https://www.okx.com/*`

原因是 extension 需要在 Binance / OKX 跟单员页面调用同站 API，取得该页本来就能看到或登录后可见的带单员数据。Extension 不会把数据传到任何第三方服务器。

Content script 只会在以下页面注入：

- `https://www.binance.com/*/copy-trading/lead-details/*`
- `https://www.okx.com/*/copy-trading/account/*`

## 隐私

请见 [PRIVACY.md](PRIVACY.md)。

简短版本：

- 没有后端
- 没有 analytics
- 没有 remote code
- 没有数据上传
- 没有 credential 储存
- 同源请求可能使用浏览器正常 session 与交易所要求的 CSRF header，但不会储存或传给第三方
- 没有静态带单员数据库

## 验证

```bash
npm run icons
npm run validate
npm run package
```

`npm run validate` 会检查必要文件、Manifest V3 约束、host permissions、JavaScript syntax、疑似 secret pattern，以及 locale message key 是否一致。

## 限制

- 交易所 API 或页面结构可能改版，导致部分数据暂时抓不到。
- Binance 全期间 ROI 是用「当前带单资金 + 已提现 - 已投入」重建；若 Binance 没提供完整历史转账或历史仓位，面板会标示数据不完整或 `N/A`。
- 年化收益在有现金流时使用 XIRR/APY；若现金流不足，才用 ROI 与交易天数推估 CAGR。短样本的年化值可能非常极端，应搭配 MDD 与交易行为判读。
- Binance 标准窗口 ROI/MDD 来自当下 live `query-list` API，只作交叉检查，不作为静态数据库。
- 未登录时，某些 Binance 数据可能不可见。
- OKX 公开数据不像 Binance 订单/转账数据那么完整，因此部分判断会比较保守。
- Hidden positions 本身不会被当作负面信号；只会标示数据不足。
- 分析结果是风险提示，不是投资建议。

## 支持 / Donate

如果 Copy Trading Lens 帮你避开不适合跟单的对象，欢迎 donation 支持维护。Extension 不内建付款功能，也不会在 Binance 或 OKX 页面要求付款。请只使用官方 repository owner 或 Chrome Web Store listing 公开的 donation 链接或地址。

## License

Creative Commons Attribution-NonCommercial 4.0 International (`CC-BY-NC-4.0`)。

可以署名分享、修改，但未经另外书面授权不得商业使用。

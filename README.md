# lottery-data · 开奖数据仓库

「今日好运」App 的开奖数据源。GitHub Actions 每天 22:30（北京时间）用 Playwright 真浏览器环境抓官方数据：

- 双色球：福彩官网 `cwl.gov.cn`（JS 挑战 cookie 由页面预热自然通过）
- 大乐透：体彩官网 `webapi.sporttery.cn`（真浏览器指纹过 EdgeOne WAF）

产出 `data/ssq.json`、`data/dlt.json`，App 经 gh-proxy 拉取：

```
https://gh-proxy.com/https://raw.githubusercontent.com/daipenn/lottery-data/main/data/ssq.json
```

## 数据格式

```json
{
  "game": "ssq",
  "source": "cwl.gov.cn",
  "fetchedAt": "2026-10-12T14:35:00.000Z",
  "count": 30,
  "results": [
    { "issue": "2026116", "date": "2026-10-11",
      "mains": [10, 19, 24, 27, 28, 33], "specials": [12] }
  ]
}
```

## 手动触发

Actions → fetch-lottery → Run workflow，或：

```bash
gh workflow run fetch-lottery -R daipenn/lottery-data
```

## 本地调试

```bash
npm i playwright && npx playwright install chromium
node scripts/fetch.mjs ssq
```

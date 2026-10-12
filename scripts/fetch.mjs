// 开奖数据抓取：GitHub Actions + Playwright（真浏览器环境）
// - 双色球: 福彩官网 API（带 JS 挑战 cookie，Playwright 页面预热后 ctx.request 自动带上）
// - 大乐透: 体彩官网 API（EdgeOne WAF，真浏览器指纹通过）
// 用法: node scripts/fetch.mjs ssq | dlt
// 产出: data/<game>.json  { game, source, fetchedAt, count, results: [{issue,date,mains,specials}] }

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GAMES = {
  ssq: {
    source: 'cwl.gov.cn',
    warmup: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
    api: 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=%E5%8F%8C%E8%89%B2%E7%90%83&issueCount=30',
    validate: (n) => n.mains.length === 6 && n.mains.every(x => x >= 1 && x <= 33)
      && n.specials.length === 1 && n.specials[0] >= 1 && n.specials[0] <= 16,
  },
  dlt: {
    source: 'sporttery.cn',
    warmup: 'https://www.sporttery.cn/',
    api: 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85&provinceId=0&pageSize=30&isVerify=1&pageNo=1',
    validate: (n) => n.mains.length === 5 && n.mains.every(x => x >= 1 && x <= 35)
      && n.specials.length === 2 && n.specials.every(x => x >= 1 && x <= 12),
  },
};

async function fetchSSQ(ctx, cfg) {
  const page = await ctx.newPage();
  try {
    // 先访问开奖页：让 JS 挑战脚本执行完、种下挑战 cookie，ctx.request 会自动携带
    await page.goto(cfg.warmup, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const resp = await ctx.request.get(cfg.api, {
      headers: { Referer: cfg.warmup },
      timeout: 60000,
    });
    if (!resp.ok()) throw new Error(`cwl HTTP ${resp.status()}`);
    const body = await resp.json();
    if (body.resultCode !== '0' || !Array.isArray(body.result)) {
      throw new Error(`cwl 返回结构异常: ${JSON.stringify(body).slice(0, 200)}`);
    }
    // result[]: { code: 期号, date: "2026-10-11(周日)", red: "10,19,24,27,28,33", blue: "12" }
    return body.result.map(it => ({
      issue: String(it.code ?? ''),
      date: String(it.date ?? '').slice(0, 10),
      mains: String(it.red ?? '').split(',').map(Number),
      specials: [Number(it.blue)],
    }));
  } finally {
    await page.close();
  }
}

async function fetchDLT(ctx, cfg) {
  const page = await ctx.newPage();
  try {
    await page.goto(cfg.warmup, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const resp = await ctx.request.get(cfg.api, {
      headers: { Referer: cfg.warmup },
      timeout: 60000,
    });
    if (!resp.ok()) throw new Error(`sporttery HTTP ${resp.status()}`);
    const body = await resp.json();
    const list = body?.value?.list;
    if (!Array.isArray(list)) {
      throw new Error(`sporttery 返回结构异常: ${JSON.stringify(body).slice(0, 200)}`);
    }
    // list[]: { lotteryDrawNum: 期号, lotteryDrawTime: "2026-10-10 21:25", lotteryDrawResult: "12 20 32 33 35 06 07" }
    return list.map(it => {
      const nums = String(it.lotteryDrawResult ?? '').trim().split(/\s+/).map(Number);
      return {
        issue: String(it.lotteryDrawNum ?? ''),
        date: String(it.lotteryDrawTime ?? '').slice(0, 10),
        mains: nums.slice(0, 5),
        specials: nums.slice(5, 7),
      };
    });
  } finally {
    await page.close();
  }
}

const game = process.argv[2];
const cfg = GAMES[game];
if (!cfg) {
  console.error(`用法: node scripts/fetch.mjs ${Object.keys(GAMES).join('|')}`);
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 800 },
  });

  const rows = game === 'ssq' ? await fetchSSQ(ctx, cfg) : await fetchDLT(ctx, cfg);

  const results = rows.filter(n =>
    /^\d{4}-\d{2}-\d{2}$/.test(n.date) && n.issue && cfg.validate(n)
  );
  if (results.length < 20) {
    throw new Error(`合法期数不足: ${results.length}（要求 ≥20），疑似页面结构变化或被拦截`);
  }

  const payload = {
    game,
    source: cfg.source,
    fetchedAt: new Date().toISOString(),
    count: results.length,
    results,
  };
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(`data/${game}.json`, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✅ ${game}: ${results.length} 期, 最新 第${results[0].issue}期 ${results[0].date} ${JSON.stringify(results[0].mains)} ${JSON.stringify(results[0].specials)}`);
} finally {
  await browser.close();
}

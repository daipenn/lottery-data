// 开奖数据抓取：GitHub Actions + Playwright（有头浏览器 + stealth 反指纹）
// - 双色球: 福彩官网 API（瑞数系 JS 挑战：先访问页面等挑战 cookie，再带 cookie 调接口）
// - 大乐透: 体彩官网 API（EdgeOne WAF 按指纹拦截，有头 + stealth 通过）
// 用法: xvfb-run -a node scripts/fetch.mjs ssq | dlt   （本地调试可不带 xvfb，直接 headless）
// 产出: data/<game>.json  { game, source, fetchedAt, count, results: [{issue,date,mains,specials}] }

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs/promises';

chromium.use(stealth());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Actions 无显示器，配合 xvfb-run 用有头模式骗过 headless 指纹检测；本地调试默认无头
const HEADED = process.env.HEADED === '1' || Boolean(process.env.DISPLAY);

const GAMES = {
  ssq: {
    source: 'cwl.gov.cn',
    warmup: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
    api: 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=%E5%8F%8C%E8%89%B2%E7%90%83&issueCount=30',
    challengeCookiePrefix: 'FSSBBIl1UgzbN7N', // 瑞数系挑战 cookie 前缀
    mainCount: 6, mainMax: 33, specialCount: 1, specialMax: 16,
    validate: (n) => n.mains.length === 6 && n.mains.every(x => x >= 1 && x <= 33)
      && n.specials.length === 1 && n.specials[0] >= 1 && n.specials[0] <= 16,
  },
  dlt: {
    source: 'sporttery.cn',
    warmup: 'https://www.sporttery.cn/',
    api: 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85&provinceId=0&pageSize=30&isVerify=1&pageNo=1',
    challengeCookiePrefix: null, // EdgeOne 不依赖挑战 cookie，靠指纹
    mainCount: 5, mainMax: 35, specialCount: 2, specialMax: 12,
    validate: (n) => n.mains.length === 5 && n.mains.every(x => x >= 1 && x <= 35)
      && n.specials.length === 2 && n.specials.every(x => x >= 1 && x <= 12),
  },
};

async function waitChallengeCookie(ctx, prefix, timeoutMs = 30000) {
  if (!prefix) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await ctx.cookies();
    if (cookies.some(c => c.name.startsWith(prefix))) {
      console.log(`挑战 cookie 已种下（${Math.round((Date.now() - start) / 1000)}s）`);
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('警告: 等待挑战 cookie 超时，继续尝试请求');
  return false;
}

async function fetchViaBrowser(ctx, cfg) {
  const page = await ctx.newPage();
  try {
    // 先访问开奖页：让 JS 挑战脚本执行完、种下挑战 cookie
    const resp = await page.goto(cfg.warmup, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`warmup 页面: HTTP ${resp?.status()} 标题:「${await page.title()}」`);
    await page.waitForTimeout(3000);
    const cookieNames = (await ctx.cookies()).map(c => c.name);
    console.log(`页面 cookies: ${cookieNames.length ? cookieNames.join(', ') : '（无）'}`);
    await waitChallengeCookie(ctx, cfg.challengeCookiePrefix);

    // 接口带重试：挑战 cookie 偶尔需要多等几秒才生效
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const apiResp = await ctx.request.get(cfg.api, {
          headers: { Referer: cfg.warmup },
          timeout: 60000,
        });
        if (!apiResp.ok()) throw new Error(`HTTP ${apiResp.status()}`);
        return cfg.source === 'cwl.gov.cn'
          ? await parseSSQBody(apiResp)
          : await parseDLTBody(apiResp);
      } catch (e) {
        lastErr = e;
        console.log(`第${attempt}次请求失败: ${e.message}`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(4000);
      }
    }
    throw lastErr;
  } finally {
    await page.close();
  }
}

async function parseSSQBody(resp) {
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
}

async function parseDLTBody(resp) {
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
}

const game = process.argv[2];
const cfg = GAMES[game];
if (!cfg) {
  console.error(`用法: node scripts/fetch.mjs ${Object.keys(GAMES).join('|')}`);
  process.exit(2);
}

// ---------- 源回退：官方(浏览器) → 500.com(纯 HTTP) ----------

async function tryOfficial(browser, cfg) {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 800 },
  });
  try {
    return await fetchViaBrowser(ctx, cfg);
  } finally {
    await ctx.close();
  }
}

// 500.com 回退源，解析逻辑与 App 端 LotteryParser / CF Worker 同源
const ROW_RE = /<tr\s+class="t_tr1">([\s\S]*?)<\/tr>/g;
const TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;

async function try500com(game) {
  const cfg = GAMES[game];
  const dir = game === 'ssq' ? 'ssq' : 'dlt';
  const resp = await fetch(`https://datachart.500.com/${dir}/history/newinc/history.php?limit=30&sort=0`, {
    headers: { 'User-Agent': UA },
  });
  if (!resp.ok) throw new Error(`500.com HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let html = new TextDecoder('utf-8').decode(buf);
  if (html.includes('\uFFFD')) html = new TextDecoder('gbk').decode(buf);

  const results = [];
  const seen = new Set();
  for (const row of html.matchAll(ROW_RE)) {
    const cells = [...row[1].matchAll(TD_RE)]
      .map(t => t[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
    const date = cells.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c)).pop();
    if (!date) continue;
    const idx = cells.findIndex(c => c.length >= 4 && c.length <= 7 && /^\d+$/.test(c));
    if (idx < 0) continue;
    const issue = cells[idx];
    if (seen.has(issue)) continue;
    // 期号后固定取 need 个两位数（不能用 takeWhile：双色球"快乐星期天"列会污染）
    const need = cfg.mainCount + cfg.specialCount;
    const balls = cells.slice(idx + 1)
      .filter(c => c.length === 2 && /^\d+$/.test(c))
      .slice(0, need)
      .map(Number);
    if (balls.length !== need) continue;
    const mains = balls.slice(0, cfg.mainCount);
    const specials = balls.slice(cfg.mainCount);
    if (!validBalls(mains, cfg.mainMax) || !validBalls(specials, cfg.specialMax)) continue;
    seen.add(issue);
    results.push({ issue, date, mains, specials });
    if (results.length >= 30) break;
  }
  return results.length > 0 ? results : null;
}

function validBalls(nums, max) {
  if (nums.length === 0) return false;
  let prev = 0;
  for (const n of nums) {
    if (n < 1 || n > max || n <= prev) return false;
    prev = n;
  }
  return true;
}

// ---------- 主流程 ----------

const rows = { official: null, fallback: null };
let officialError = null;

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
try {
  try {
    rows.official = await tryOfficial(browser, cfg);
    console.log('官方源抓取成功');
  } catch (e) {
    officialError = e;
    console.log(`官方源失败（${e.message}），回退 500.com`);
  }
} finally {
  await browser.close();
}

let rows_final = rows.official;
let source = cfg.source;
if (!rows_final) {
  rows_final = await try500com(game);
  source = '500.com';
  if (officialError) console.log(`官方源错误详情: ${officialError.message}`);
}
if (!rows_final) {
  throw new Error('官方源与 500.com 全部失败');
}

const results = rows_final.filter(n =>
  /^\d{4}-\d{2}-\d{2}$/.test(n.date) && n.issue && cfg.validate(n)
);
if (results.length < 20) {
  throw new Error(`合法期数不足: ${results.length}（要求 ≥20），疑似页面结构变化`);
}

const payload = {
  game,
  source,
  fetchedAt: new Date().toISOString(),
  count: results.length,
  results,
};
await fs.mkdir('data', { recursive: true });
await fs.writeFile(`data/${game}.json`, JSON.stringify(payload, null, 2) + '\n');
console.log(`✅ [${source}] ${game}: ${results.length} 期, 最新 第${results[0].issue}期 ${results[0].date} ${JSON.stringify(results[0].mains)} ${JSON.stringify(results[0].specials)}`);

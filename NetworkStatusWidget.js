/**
 * 网络状态小组件 — 流媒体解锁检测 + IP 风险评估
 * 版本：v2（新增透明模式 + 健壮性优化）
 *
 * POLICY：
 *   指定策略组或节点
 *
 * STYLE：
 *   "glass" 启用透明模式（不设置任何背景色，卡片描边极淡，壁纸直接透出）
 *
 * 示例：
 *   widgets:
 *     - name: "网络状态"
 *       script: 数据中心
 *       env:
 *         POLICY: "本地节点"
 *         STYLE: "glass"
 *
 * 也可以：
 *   POLICY: "新加坡"
 *   POLICY: "🇭🇰 香港01"
 *   POLICY: "DIRECT"
 *
 * v2 变更说明：
 *   - 新增 STYLE=glass 透明模式（学习 IPPure 脚本：透明时不设置背景，仅加极淡描边）
 *   - ChatGPT / TikTok 检测中的子请求改为独立容错，单次子请求失败不再让整体误判为"Cross"
 *   - 移除了会让 ATS 直接拦截明文 HTTP 请求的 http://ip-api.com 调用，
 *     改为直接复用前面已经拿到的落地 IP（nIp）去查 ipapi.is，少一次不稳定的外部请求
 *   - IPPure / ipapi.is 检测失败时如实显示"检测失败"（灰色），不再误显示成"低危"（绿色）
 *   - 移除了 IP2Location / DB-IP / ipregistry 三行写死的假数据（原脚本从未真正请求这三个服务）
 *   - ipapi.is 检测和 5 项流媒体检测合并进同一个 Promise.all 并行执行，减少总耗时
 *   - 整个渲染逻辑外层加了 try/catch 兜底，出错时显示错误卡片而不是完全空白
 */

async function renderWidget(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';
  const isGlass = (ctx.env.STYLE || '').toLowerCase() === 'glass';

  const BG_COLOR = { light: '#F2F2F7', dark: '#000000' };
  const C_TITLE = { light: '#1A1A1A', dark: '#FFFFFF' };
  const C_SUB = { light: '#666666', dark: '#B0B0B0' };
  const C_MAIN = { light: '#1A1A1A', dark: '#FFFFFF' };
  const C_GREEN = { light: '#32D74B', dark: '#32D74B' };
  const C_YELLOW = { light: '#FF9500', dark: '#FF9500' };
  const C_ORANGE = { light: '#FF9500', dark: '#FF9500' };
  const C_RED = { light: '#FF3B30', dark: '#FF3B30' };
  const C_ICON = { light: '#007AFF', dark: '#0A84FF' };
  const C_MUTED = { light: '#8E8E93', dark: '#8E8E93' };

  // 透明模式：不设置任何背景属性（真透明，壁纸直接透出），只留一条几乎看不见的描边勾边界
  const glassBorderColor = { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.08)' };
  const bgProps = isGlass ? {} : { backgroundColor: BG_COLOR };
  const borderProps = isGlass ? { borderWidth: 1, borderColor: glassBorderColor } : {};

  if (
    [
      'systemSmall',
      'accessoryCircular',
      'accessoryInline',
      'accessoryRectangular'
    ].includes(widgetFamily)
  ) {
    return {
      type: 'widget',
      padding: 16,
      ...bgProps,
      ...borderProps,
      children: [
        {
          type: 'text',
          text: '请使用中号或大号组件',
          font: { size: 'callout' },
          textColor: C_MAIN,
          textAlign: 'center'
        }
      ]
    };
  }

  const policy = ctx.env.POLICY || "";

  const BASE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Version/17.4 Mobile/15E148 Safari/604.1";

  async function safe(fn) {
    try {
      return await fn();
    } catch (e) {
      return null;
    }
  }

  function applyPolicy(opts) {
    if (policy) {
      opts.policy = policy;
    }
    return opts;
  }

  async function get(url, headers) {
    const opts = { timeout: 6000 };
    if (headers) opts.headers = headers;
    applyPolicy(opts);
    const res = await ctx.http.get(url, opts);
    return await res.text();
  }

  async function post(url, body, headers) {
    const opts = { timeout: 6000, body: body };
    if (headers) opts.headers = headers;
    applyPolicy(opts);
    const res = await ctx.http.post(url, opts);
    return await res.text();
  }

  async function getRaw(url, headers, extraOpts) {
    const opts = { timeout: 6000 };
    if (headers) opts.headers = headers;
    applyPolicy(opts);
    if (extraOpts) Object.assign(opts, extraOpts);
    return await ctx.http.get(url, opts);
  }

  function jp(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function ti(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  /*
   * ============================================================
   * ChatGPT — 两个子请求各自独立容错，
   * 不再是"任意一个抛异常就整体判定 Cross"
   * ============================================================
   */
  async function checkChatGPT() {
    const headRes = await safe(() =>
      getRaw("https://chatgpt.com", { "User-Agent": BASE_UA }, { redirect: 'manual' })
    );
    const webAccessible = !!headRes;

    const iosRes = await safe(() =>
      getRaw("https://ios.chat.openai.com", { "User-Agent": BASE_UA })
    );
    const iosBody = iosRes ? await safe(() => iosRes.text()) : null;

    let cfDetails = "";
    if (iosBody) {
      const parsed = jp(iosBody);
      cfDetails = parsed?.cf_details || "";
    }

    const appBlocked =
      !iosBody ||
      iosBody.includes("blocked_why_headline") ||
      iosBody.includes("unsupported_country_region_territory") ||
      cfDetails.includes("(1)") ||
      cfDetails.includes("(2)");

    const appAccessible = !!iosBody && !appBlocked;

    if (!webAccessible && !appAccessible) return "Cross";
    if (appAccessible && !webAccessible) return "APP";

    if (webAccessible && appAccessible) {
      const traceTxt = await safe(() => get("https://chatgpt.com/cdn-cgi/trace"));
      const tm = traceTxt ? traceTxt.match(/loc=([A-Z]{2})/) : null;
      if (tm && tm[1]) return tm[1];
      return "OK";
    }

    // 只有 web 可访问、app 检测本身失败（不代表真的被墙）时，仍报告已知的可用信息
    return webAccessible ? "OK" : "Cross";
  }

  /*
   * ============================================================
   * Gemini
   * ============================================================
   */
  async function checkGemini() {
    const bodyRaw = 'f.req=[["K4WWud","[[0],[\\"en-US\\"]]",null,"generic"]]';
    const txt = await safe(() =>
      post(
        'https://gemini.google.com/_/BardChatUi/data/batchexecute',
        bodyRaw,
        { "User-Agent": BASE_UA, "Accept-Language": "en-US", "Content-Type": "application/x-www-form-urlencoded" }
      )
    );
    if (!txt) return "Cross";

    let m = txt.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
    if (m && m[1]) return m[1].toUpperCase();

    m = txt.match(/"requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Z]{2})"/i);
    if (m && m[1]) return m[1].toUpperCase();

    m = txt.match(/\[\[\\?"([A-Z]{2})\\?",\\?"S/);
    if (m && m[1]) return m[1].toUpperCase();

    return "OK";
  }

  /*
   * ============================================================
   * YouTube
   * ============================================================
   */
  async function checkYouTube() {
    const body = await safe(() =>
      get('https://www.youtube.com/premium', { "User-Agent": BASE_UA, "Accept-Language": "en" })
    );
    if (!body) return "Cross";

    if (body.includes('www.google.cn')) return "CN";

    const isNotAvailable =
      body.includes('Premium is not available in your country') ||
      body.includes('YouTube Premium is not available');

    const m = body.match(/"contentRegion"\s*:\s*"?([A-Z]{2})"?/);
    const region = m && m[1] ? m[1].toUpperCase() : null;
    const isAvailable = body.includes('ad-free') || body.includes('Ad-free');

    if (isNotAvailable) return "Cross";
    if (isAvailable && region) return region;
    if (isAvailable && !region) return "OK";
    if (region) return region;
    return "Cross";
  }

  /*
   * ============================================================
   * Netflix
   * ============================================================
   */
  async function checkNetflix() {
    const titles = [
      "https://www.netflix.com/title/81280792",
      "https://www.netflix.com/title/70143836"
    ];
    const fetchTitle = (url) => safe(() => get(url, { "User-Agent": BASE_UA }));
    const [t1, t2] = await Promise.all([fetchTitle(titles[0]), fetchTitle(titles[1])]);

    if (!t1 && !t2) return "Cross";

    const oh1 = /oh no!/i.test(t1 || "");
    const oh2 = /oh no!/i.test(t2 || "");
    if (oh1 && oh2) return "Popcorn";

    for (const b of [t1, t2]) {
      if (!b) continue;
      const rm = b.match(/"countryCode"\s*:\s*"?([A-Z]{2})"?/);
      if (rm && rm[1]) return rm[1];
    }
    return "OK";
  }

  /*
   * ============================================================
   * TikTok — 每个子请求独立容错，第一步失败也会继续尝试第二种请求方式
   * ============================================================
   */
  async function checkTikTok() {
    let body1 = await safe(() => get("https://www.tiktok.com/", { "User-Agent": BASE_UA }));

    if (body1 && body1.includes("Please wait...")) {
      body1 = (await safe(() => get("https://www.tiktok.com/explore", { "User-Agent": BASE_UA }))) || body1;
    }

    const m1 = body1 ? body1.match(/"region"\s*:\s*"([A-Z]{2})"/) : null;
    if (m1 && m1[1]) return m1[1];

    const body2 = await safe(() =>
      get("https://www.tiktok.com/", { "User-Agent": BASE_UA, "Accept-Language": "en" })
    );
    const m2 = body2 ? body2.match(/"region"\s*:\s*"([A-Z]{2})"/) : null;
    if (m2 && m2[1]) return m2[1];

    if (body1 || body2) return "OK";
    return "Cross";
  }

  /*
   * ============================================================
   * 本地 ISP 名称归一化
   * ============================================================
   */
  const fmtISP = (isp) => {
    if (!isp) return "未知";
    const s = String(isp).toLowerCase();
    if (/移动|mobile|cmcc/i.test(s)) return "中国移动";
    if (/电信|telecom|chinanet/i.test(s)) return "中国电信";
    if (/联通|unicom/i.test(s)) return "中国联通";
    if (/广电|broadcast|cbn/i.test(s)) return "中国广电";
    return isp;
  };

  /*
   * ============================================================
   * 本地 IP（故意不使用 POLICY，显示手机当前真实网络出口）
   * 两级 fallback，JSON 解析改用 jp() 避免抛异常中断
   * ============================================================
   */
  let lIp = "获取失败";
  let lLoc = "未知位置";
  let lIsp = "未知运营商";

  const localRes1 = await safe(() =>
    ctx.http.get('https://myip.ipip.net/json', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 })
  );
  const localBody1 = localRes1 ? jp(await safe(() => localRes1.text())) : null;

  if (localBody1?.data) {
    lIp = localBody1.data.ip || "获取失败";
    const locArr = localBody1.data.location || [];
    lLoc = `🇨🇳 ${locArr[1] || ""} ${locArr[2] || ""}`.trim() || "未知位置";
    lIsp = fmtISP(locArr[4] || locArr[3]);
  }

  if (lIp === "获取失败") {
    const localRes2 = await safe(() =>
      ctx.http.get('https://ipservice.ws.126.net/locate/api/getLocByIp', {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000
      })
    );
    const localBody2 = localRes2 ? jp(await safe(() => localRes2.text())) : null;

    if (localBody2?.result) {
      lIp = localBody2.result.ip || "获取失败";
      lLoc = `🇨🇳 ${localBody2.result.province || ""} ${localBody2.result.city || ""}`.trim() || "未知位置";
      lIsp = fmtISP(localBody2.result.operator || localBody2.result.company);
    }
  }

  /*
   * ============================================================
   * 代理落地 IP / IPPure（严格使用 POLICY）
   * 失败时明确标注"检测失败"，不再悄悄保留具有误导性的默认"低危"
   * ============================================================
   */
  let nIp = "获取失败";
  let nLoc = "未知位置";
  let nativeText = "未知";

  let riskIPPureTxt = "检测失败";
  let riskIPPureCol = C_MUTED;
  let ippSev = 0;
  let ippKnown = false;

  const ippRes = await safe(() => getRaw('https://my.ippure.com/v1/info'));
  const ippBody = ippRes ? jp(await safe(() => ippRes.text())) : null;

  if (ippBody) {
    nIp = ippBody.ip || "获取失败";

    let code = ippBody.countryCode || "";
    if (code.toUpperCase() === 'TW') code = 'CN';
    const flag = code
      ? String.fromCodePoint(...code.toUpperCase().split('').map(c => 127397 + c.charCodeAt()))
      : "🌍";
    nLoc = `${flag} ${ippBody.country || ""} ${ippBody.city || ""}`.trim() || "未知位置";

    nativeText =
      ippBody.isResidential === true ? "🏠 原生住宅" :
      ippBody.isResidential === false ? "🏢 商业机房" : "未知";

    const risk = ti(ippBody.fraudScore);
    if (risk !== null) {
      ippKnown = true;
      if (risk >= 80) { riskIPPureTxt = `极高 (${risk})`; riskIPPureCol = C_RED; ippSev = 4; }
      else if (risk >= 70) { riskIPPureTxt = `高危 (${risk})`; riskIPPureCol = C_ORANGE; ippSev = 3; }
      else if (risk >= 40) { riskIPPureTxt = `中等 (${risk})`; riskIPPureCol = C_YELLOW; ippSev = 1; }
      else { riskIPPureTxt = `低危 (${risk})`; riskIPPureCol = C_GREEN; ippSev = 0; }
    }
  }

  const proxySuccess = nIp !== "获取失败";

  /*
   * ============================================================
   * ipapi.is 风险检测
   * 不再额外请求 http://ip-api.com（明文 HTTP，容易被 ATS 拦截），
   * 直接复用上面已经拿到的落地 IP（nIp）
   * ============================================================
   */
  async function checkIpapiRisk(ip) {
    if (!ip || ip === "获取失败") {
      return { txt: "检测失败", col: C_MUTED, sev: 0, known: false };
    }
    const apiRes = await safe(() => getRaw(`https://api.ipapi.is/?q=${ip}`));
    const j = apiRes ? jp(await safe(() => apiRes.text())) : null;

    if (j?.company?.abuser_score) {
      const m = String(j.company.abuser_score).match(/([0-9.]+)\s*\(([^)]+)\)/);
      if (m) {
        const pct = Math.round(Number(m[1]) * 10000) / 100 + '%';
        const lv = m[2].trim();
        const col = (lv.includes('High') || lv.includes('Very High')) ? C_ORANGE
          : lv.includes('Elevated') ? C_YELLOW : C_GREEN;
        const sev = (lv.includes('High') || lv.includes('Very High')) ? 3
          : lv.includes('Elevated') ? 2 : 0;
        return { txt: `${lv} (${pct}) Abuser`, col, sev, known: true };
      }
    }
    return { txt: "检测失败", col: C_MUTED, sev: 0, known: false };
  }

  /*
   * ============================================================
   * 流媒体检测 + ipapi.is 风险检测合并并行执行，减少总耗时
   * ============================================================
   */
  const [
    ipapiRisk,
    gptStatus,
    geminiStatus,
    youtubeStatus,
    netflixStatus,
    tiktokStatus
  ] = await Promise.all([
    checkIpapiRisk(nIp),
    checkChatGPT(),
    checkGemini(),
    checkYouTube(),
    checkNetflix(),
    checkTikTok()
  ]);

  /*
   * ============================================================
   * 风险等级汇总
   * 只有真正拿到结果（known）的检测项才计入总体严重度判断，
   * 检测失败的项不再冒充"低危"拉低整体风险
   * ============================================================
   */
  const getUnlockColor = (status) => (status === "Cross" || status === "CN") ? C_RED : C_GREEN;
  const getUnlockResult = (status) => {
    if (status === "Cross") return "不可用";
    if (status === "CN") return "CN";
    return status;
  };

  let riskGrades = [];
  if (proxySuccess) {
    riskGrades.push({ sev: ippSev, t: `IPPure: ${riskIPPureTxt}`, known: ippKnown });
    riskGrades.push({ sev: ipapiRisk.sev, t: `ipapi: ${ipapiRisk.txt}`, known: ipapiRisk.known });
  } else {
    riskGrades.push({ sev: 4, t: '获取失败', known: true });
  }

  const knownGrades = riskGrades.filter(g => g.known);
  let maxSev = 0;
  knownGrades.forEach(g => { if (g.sev > maxSev) maxSev = g.sev; });
  const hasAnyKnownRisk = knownGrades.length > 0;

  function sevIcon(sev) {
    if (sev >= 4) return 'xmark.shield.fill';
    if (sev >= 3) return 'exclamationmark.shield.fill';
    if (sev >= 1) return 'exclamationmark.shield.fill';
    return 'checkmark.shield.fill';
  }
  function sevText(sev) {
    if (sev >= 4) return '极高风险';
    if (sev >= 3) return '高风险';
    if (sev >= 2) return '中等风险';
    if (sev >= 1) return '中低风险';
    return '纯净低危';
  }
  function sevColor(sev) {
    if (sev >= 4) return C_RED;
    if (sev >= 3) return C_ORANGE;
    if (sev >= 1) return C_YELLOW;
    return C_GREEN;
  }

  const summaryIcon = hasAnyKnownRisk ? sevIcon(maxSev) : 'questionmark.circle.fill';
  const summaryTxt = hasAnyKnownRisk ? sevText(maxSev) : '无法判断';
  const summaryCol = hasAnyKnownRisk ? sevColor(maxSev) : C_MUTED;

  const SMALL_FONT = 10;
  const SMALL_ICON = 12;

  function smallInfoRow(iconName, label, value, valueCol = C_MAIN) {
    return {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
      children: [
        { type: 'image', src: `sf-symbol:${iconName}`, color: C_ICON, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: label, font: { size: SMALL_FONT }, textColor: C_SUB },
        { type: 'spacer' },
        { type: 'text', text: value, font: { size: SMALL_FONT, weight: 'bold' }, textColor: valueCol, maxLines: 1, lineBreakMode: 'tail' }
      ]
    };
  }

  function UnlockRow(name, status) {
    const iconName = (status === "Cross" || status === "CN") ? "xmark.circle.fill" : "checkmark.circle.fill";
    const iconCol = getUnlockColor(status);
    const result = getUnlockResult(status);
    return {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        { type: 'image', src: `sf-symbol:${iconName}`, color: iconCol, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: name, font: { size: SMALL_FONT, weight: 'medium' }, textColor: C_MAIN },
        { type: 'spacer' },
        { type: 'text', text: result, font: { size: SMALL_FONT, weight: 'bold' }, textColor: iconCol, maxLines: 1 }
      ]
    };
  }

  function ScoreRow(grade) {
    const col = grade.known ? sevColor(grade.sev) : C_MUTED;
    const parts = grade.t.split(': ');
    const src = parts[0] || grade.t;
    const val = parts[1] || '';
    return {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        { type: 'image', src: `sf-symbol:${grade.known ? sevIcon(grade.sev) : 'questionmark.circle.fill'}`, color: col, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: src, font: { size: SMALL_FONT }, textColor: C_SUB },
        { type: 'spacer' },
        { type: 'text', text: val, font: { size: SMALL_FONT, weight: 'bold' }, textColor: col, maxLines: 1, lineBreakMode: 'tail' }
      ]
    };
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isLarge = widgetFamily === 'systemLarge';
  const WIDGET_PADDING = isLarge ? [10, 12] : [8, 10];

  const HEADER_FONT = 13;
  const HEADER_ICON = 11;
  const HEADER_TIME_FONT = 10;
  const HEADER_GAP = 4;
  const TOP_GAP = 3;
  const INFO_GAP = 2.5;
  const BOTTOM_GAP_LEFT = 2;
  const BOTTOM_GAP_RIGHT = 2;
  const COL_GAP = 12;

  const leftColumn = {
    type: 'stack', direction: 'column', gap: INFO_GAP, flex: 1,
    children: [
      smallInfoRow("house.fill", "本地IP：", lIp, C_GREEN),
      smallInfoRow("mappin.and.ellipse", "本地位置：", lLoc),
      smallInfoRow("simcard.fill", "本地运营商：", lIsp)
    ]
  };

  const rightColumn = {
    type: 'stack', direction: 'column', gap: INFO_GAP, flex: 1,
    children: [
      smallInfoRow("network", "落地IP：", nIp, proxySuccess ? C_GREEN : C_RED),
      smallInfoRow("map.fill", "落地位置：", nLoc, proxySuccess ? C_MAIN : C_RED),
      smallInfoRow("building.2.fill", "原生属性：", nativeText, proxySuccess ? C_MAIN : C_RED)
    ]
  };

  const unlockLeft = {
    type: 'stack', direction: 'column', gap: BOTTOM_GAP_LEFT,
    children: [
      UnlockRow("GPT", gptStatus),
      UnlockRow("Gemini", geminiStatus),
      UnlockRow("YouTube", youtubeStatus),
      UnlockRow("Netflix", netflixStatus),
      UnlockRow("TikTok", tiktokStatus)
    ]
  };

  const unlockRight = {
    type: 'stack', direction: 'column', gap: BOTTOM_GAP_RIGHT,
    children: riskGrades.map(g => ScoreRow(g))
  };

  const unlockSection = {
    type: 'stack', direction: 'row', gap: COL_GAP,
    children: [unlockLeft, unlockRight]
  };

  return {
    type: 'widget',
    padding: WIDGET_PADDING,
    gap: TOP_GAP,
    ...bgProps,
    ...borderProps,
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: HEADER_GAP,
        children: [
          { type: 'text', text: '数据中心(DCH)', font: { size: HEADER_FONT, weight: 'heavy' }, textColor: C_TITLE, flex: 1 },
          { type: 'image', src: `sf-symbol:${summaryIcon}`, color: summaryCol, width: 12, height: 12 },
          { type: 'text', text: summaryTxt, font: { size: 10, weight: 'bold' }, textColor: summaryCol },
          { type: 'spacer' },
          {
            type: 'stack', direction: 'row', alignItems: 'center', gap: 3,
            children: [
              { type: 'image', src: 'sf-symbol:arrow.clockwise', color: C_SUB, width: HEADER_ICON, height: HEADER_ICON },
              { type: 'text', text: timeStr, font: { size: HEADER_TIME_FONT }, textColor: C_SUB }
            ]
          }
        ]
      },
      { type: 'stack', direction: 'row', gap: COL_GAP, children: [leftColumn, rightColumn] },
      { type: 'stack', height: 0.5, backgroundColor: { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.12)' } },
      unlockSection
    ]
  };
}

// 最外层兜底：任何未被内部捕获的异常都不会让小组件彻底渲染失败，
// 而是显示一张说明出错原因的卡片
export default async function (ctx) {
  try {
    return await renderWidget(ctx);
  } catch (e) {
    return {
      type: 'widget',
      padding: 16,
      backgroundColor: { light: '#F2F2F7', dark: '#000000' },
      children: [
        {
          type: 'text',
          text: '⚠️ 小组件渲染出错',
          font: { size: 'callout', weight: 'bold' },
          textColor: { light: '#FF3B30', dark: '#FF453A' },
          textAlign: 'center'
        },
        {
          type: 'text',
          text: String((e && e.message) || e || '未知错误'),
          font: { size: 'caption2' },
          textColor: { light: '#8E8E93', dark: '#8E8E93' },
          textAlign: 'center',
          maxLines: 3
        }
      ]
    };
  }
}

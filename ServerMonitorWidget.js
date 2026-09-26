// Server Monitor Widget for Egern (自适应深浅色 + 纯透明模式)
// 环境变量：
//   host, username, password 或 privateKey, port（默认 22）
//   glass       = 1/true/yes/on → 完全透明模式，不设置任何背景（默认关闭，使用纯色深色/浅色背景）
//   flag        = 任意 emoji，如 🇸🇬  → 大号组件标题栏左侧显示的国旗/图标（默认显示服务器图标）
//   displayName = 自定义名称，如 "Oracle Singapore" → 大号组件标题（默认使用主机名）
//
// 中号组件（systemMedium）的各处间距/圆环大小已按调好的效果写死在代码里
// （见 systemMedium 分支开头的 gapTitleToSpec / medGaugeSize / medStatRowGap 等常量），
// 不再通过环境变量控制；如需再调整，直接改那几行的数值即可。

export default async function (ctx) {
  // ---------- 工具函数 ----------
  const fmtBytes = b => {
    if (b >= 1e12) return (b / 1e12).toFixed(1) + 'T';
    if (b >= 1e9)  return (b / 1e9).toFixed(1) + 'G';
    if (b >= 1e6)  return (b / 1e6).toFixed(1) + 'M';
    if (b >= 1e3)  return (b / 1e3).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  const fmtBytesParts = b => {
    if (b >= 1e12) return [(b / 1e12).toFixed(1), 'TB/s'];
    if (b >= 1e9)  return [(b / 1e9).toFixed(1), 'GB/s'];
    if (b >= 1e6)  return [(b / 1e6).toFixed(1), 'MB/s'];
    if (b >= 1e3)  return [(b / 1e3).toFixed(1), 'KB/s'];
    return [Math.round(b).toString(), 'B/s'];
  };

  // ---------- 数据获取 ----------
  let d;
  try {
    const { host, username, password, privateKey, port } = ctx.env;
    if (!host || !username) throw new Error('请配置 host 和 username');

    const session = await ctx.ssh.connect({
      host,
      port: Number(port || 22),
      username,
      ...(privateKey ? { privateKey } : { password }),
      timeout: 8000,
    });

    const SEP = '<<SEP>>';
    const cmds = [
      'hostname -s 2>/dev/null || hostname',
      'cat /proc/loadavg',
      'cat /proc/uptime',
      'head -1 /proc/stat',
      'free -b',
      'df -B1 / | tail -1',
      'nproc',
      'uname -r',
      "awk '/^ *(eth|en|wlan|ens|eno|bond|veth)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
      'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || cat /sys/class/hwmon/hwmon0/temp1_input 2>/dev/null || echo 0',
      "awk '$3~/^(sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/{r+=$6;w+=$10}END{print r*512,w*512}' /proc/diskstats 2>/dev/null || echo '0 0'",
      "ls /proc 2>/dev/null | grep -c '^[0-9]' || echo 0",
    ];

    const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
    await session.close();

    const p = stdout.split(SEP).map(s => s.trim());
    const hostname = p[0] || 'server';
    const la = (p[1] || '0 0 0').split(' ');
    const load = [la[0], la[1], la[2]];

    const uptimeSec = parseFloat((p[2] || '0').split(' ')[0]) || 0;
    const uptimeDays = Math.floor(uptimeSec / 86400);
    const uptimeHours = Math.floor((uptimeSec % 86400) / 3600);
    const uptimeMins = Math.floor((uptimeSec % 3600) / 60);
    const uptime = `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`;

    // CPU
    const cpuNums = (p[3] || '').replace(/^cpu\s+/, '').split(/\s+/).map(Number);
    const cpuTotal = cpuNums.reduce((a, b) => a + b, 0);
    const cpuIdle = cpuNums[3] || 0;

    const prevCpu = ctx.storage.getJSON('_cpu');
    let cpuPct = 0;

    if (prevCpu && cpuTotal > prevCpu.t) {
      cpuPct = Math.round(
        ((cpuTotal - prevCpu.t - (cpuIdle - prevCpu.i)) /
          (cpuTotal - prevCpu.t)) * 100
      );
    }

    ctx.storage.setJSON('_cpu', { t: cpuTotal, i: cpuIdle });
    cpuPct = Math.max(0, Math.min(100, cpuPct || 0));

    const cpuHist = ctx.storage.getJSON('_cpuH') || [];
    cpuHist.push(cpuPct);
    while (cpuHist.length > 20) cpuHist.shift();
    ctx.storage.setJSON('_cpuH', cpuHist);

    // Memory
    const memLine = (p[4] || '').split('\n').find(l => /^Mem:/.test(l)) || '';
    const swapLine = (p[4] || '').split('\n').find(l => /^Swap:/.test(l)) || '';
    const mm = memLine.split(/\s+/);
    const sm = swapLine.split(/\s+/);

    const memTotal = Number(mm[1]) || 1;
    const memUsed = Number(mm[2]) || 0;
    const memPct = Math.round((memUsed / memTotal) * 100);

    const swapTotal = Number(sm[1]) || 0;
    const swapUsed = Number(sm[2]) || 0;
    const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

    const memHist = ctx.storage.getJSON('_memH') || [];
    memHist.push(memPct);
    while (memHist.length > 20) memHist.shift();
    ctx.storage.setJSON('_memH', memHist);

    // Disk
    const df = (p[5] || '').split(/\s+/);
    const diskTotal = Number(df[1]) || 1;
    const diskUsed = Number(df[2]) || 0;
    const diskPct = parseInt(df[4]) || 0;

    const cores = parseInt(p[6]) || 1;
    const kernel = (p[7] || '').split('-')[0];

    // Network
    const nn = (p[8] || '0 0').split(' ');
    const netRx = Number(nn[0]) || 0;
    const netTx = Number(nn[1]) || 0;

    const prevNet = ctx.storage.getJSON('_net');
    const now = Date.now();
    let rxRate = 0;
    let txRate = 0;

    if (prevNet && prevNet.ts) {
      const el = (now - prevNet.ts) / 1000;
      if (el > 0 && el < 3600) {
        rxRate = Math.max(0, (netRx - prevNet.rx) / el);
        txRate = Math.max(0, (netTx - prevNet.tx) / el);
      }
    }

    ctx.storage.setJSON('_net', { rx: netRx, tx: netTx, ts: now });

    // Temperature
    const tempRaw = parseInt(p[9]) || 0;
    const temp = tempRaw > 1000 ? Math.round(tempRaw / 1000) : tempRaw;

    // Disk I/O
    const dio = (p[10] || '0 0').split(' ');
    const drt = Number(dio[0]) || 0;
    const dwt = Number(dio[1]) || 0;

    const prevDsk = ctx.storage.getJSON('_dsk');
    let diskRd = 0;
    let diskWr = 0;

    if (prevDsk && prevDsk.ts) {
      const el = (now - prevDsk.ts) / 1000;
      if (el > 0 && el < 3600) {
        diskRd = Math.max(0, (drt - prevDsk.r) / el);
        diskWr = Math.max(0, (dwt - prevDsk.w) / el);
      }
    }

    ctx.storage.setJSON('_dsk', { r: drt, w: dwt, ts: now });

    const procs = parseInt(p[11]) || 0;

    d = {
      hostname, load, uptime, uptimeDays, cpuPct, cpuHist, cores, kernel,
      memTotal, memUsed, memPct, memHist, swapTotal, swapUsed, swapPct,
      diskTotal, diskUsed, diskPct, diskRd, diskWr,
      rxRate, txRate, netRx, netTx, temp, procs
    };

  } catch (e) {
    d = { error: String(e.message || e) };
  }

  // ---------- 主题 ----------
  const glass = ['1', 'true', 'yes', 'on'].includes(
    String(ctx.env.glass || '').toLowerCase()
  );

  const C = {
    barBg:  { light: '#E5E5EA', dark: '#3A3A3C' },
    // 分隔线改为实色灰，之前的半透明黑/白（'#0000001A' / '#FFFFFF1F'）在部分背景下几乎看不见
    divider:{ light: '#D1D1D6', dark: '#48484A' },
    text:   { light: '#1C1C1E', dark: '#F5F5F7' },
    muted:  { light: '#8E8E93', dark: '#8E8E93' },
    dim:    { light: '#AEAEB2', dark: '#636366' },
    cpu:    { light: '#34C759', dark: '#30D158' },
    mem:    { light: '#007AFF', dark: '#0A84FF' },
    disk:   { light: '#FF9500', dark: '#FF9F0A' },
    net:    { light: '#FF2D55', dark: '#FF375F' },
    temp:   { light: '#FF3B30', dark: '#FF453A' },
    warn:   { light: '#FF9500', dark: '#FF9F0A' }
  };

  const pctColor = (pct, lo = 60, hi = 85) => {
    if (pct >= hi) return C.temp;
    if (pct >= lo) return C.warn;
    return C.cpu;
  };

  // 圆环描边颜色：与 pctColor 同样的 60/85 分级阈值（绿 / 黄 / 红），
  // 但 SVG 是离屏渲染的静态图片，无法感知当前是浅色还是深色模式，
  // 所以这里固定取一组在两种模式下都清晰可辨的实色，而不是 {light, dark} 对象。
  const gaugeStrokeColor = pct => {
    if (pct >= 85) return '#FF453A'; // 高负载：红
    if (pct >= 60) return '#FF9F0A'; // 偏高：橙/黄
    return '#30D158';                // 低负载：绿
  };

  const bg = glass
    ? {}
    : {
        backgroundColor: { light: '#FFFFFF', dark: '#121111' }
      };

  // ---------- 通用组件 ----------
  // 之前 hDivider 只设置了 height，没有宽度：空容器（children: []）没有任何东西
  // 撑开它，布局引擎会把它折叠成宽度为 0 的线，导致颜色再深也完全不可见。
  // 这里把它包进一个 row，用 flex: 1 强制内部色块占满整行宽度。
  const hDivider = () => ({
    type: 'stack',
    direction: 'row',
    height: 1,
    children: [
      {
        type: 'stack',
        height: 1,
        backgroundColor: C.divider,
        flex: 1,
        children: []
      }
    ]
  });

  // 圆环颜色现在按使用率分级（绿/黄/红），不再是固定的蓝→绿渐变；
  // 环的填充长度逻辑不变，依然是按 pct 画弧长。
  const gaugeSvg = pct => {
    const p = Math.max(0, Math.min(100, pct));
    const r = 40;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - p / 100);
    const strokeColor = gaugeStrokeColor(p);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#8E8E9355" stroke-width="9"/>` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 50 50)"/>` +
      `</svg>`;

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  // fontSize 为新增可选参数（默认 12，与原来的写死值保持一致），
  // 小号/大号组件调用时不传该参数，行为与之前完全相同。
  const gauge = (label, pct, size = 76, fontSize = 12) => ({
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    gap: 4,
    children: [
      {
        type: 'text',
        text: label,
        font: { size: 'caption1', weight: 'medium' },
        textColor: C.dim
      },
      {
        type: 'stack',
        width: size,
        height: size,
        backgroundImage: gaugeSvg(pct),
        direction: 'row',
        alignItems: 'center',
        children: [
          { type: 'spacer' },
          {
            type: 'text',
            text: `${Math.round(pct)}%`,
            font: { size: fontSize, weight: 'bold', family: 'Menlo' },
            textColor: { light: '#000000', dark: '#FFFFFF' },
            textAlign: 'center'
          },
          { type: 'spacer' }
        ]
      }
    ]
  });

  // 不带标题的圆环，只画圆环本身，供中号组件的"共享标题行 + 共享内容行"布局使用。
  // 圆环容器的 width/height 直接等于 size，不受 fontSize 影响，
  // 所以改字体大小不会改变圆环的上下占位高度。
  const gaugeCircleOnly = (pct, size, fontSize) => ({
    type: 'stack',
    width: size,
    height: size,
    backgroundImage: gaugeSvg(pct),
    direction: 'row',
    alignItems: 'center',
    children: [
      { type: 'spacer' },
      {
        type: 'text',
        text: `${Math.round(pct)}%`,
        font: { size: fontSize, weight: 'bold', family: 'Menlo' },
        textColor: { light: '#000000', dark: '#FFFFFF' },
        textAlign: 'center'
      },
      { type: 'spacer' }
    ]
  });

  const specItem = (icon, text, size = 13) => ({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      {
        type: 'image',
        src: `sf-symbol:${icon}`,
        color: C.muted,
        width: size,
        height: size
      },
      {
        type: 'text',
        text,
        font: { size: 'caption1', weight: 'medium' },
        textColor: C.muted
      }
    ]
  });

  // fontSize  = 数值文字大小（原来的 size 参数，默认 16，与旧行为一致）
  // iconSize  = 图标大小，不传时按旧公式 fontSize-1 计算（与旧行为一致）
  // unitSize  = 单位文字大小（原来写死 11，现在可单独传参覆盖）
  const statLine = (icon, value, unit, fontSize = 16, iconSize = fontSize - 1, unitSize = 11, rowHeight) => ({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    ...(rowHeight ? { height: rowHeight } : {}),
    children: [
      {
        type: 'image',
        src: `sf-symbol:${icon}`,
        color: C.dim,
        width: iconSize,
        height: iconSize
      },
      {
        type: 'text',
        text: value,
        font: { size: fontSize, weight: 'bold', family: 'Menlo' },
        textColor: C.text,
        // 数值再长也强制一行显示，宁可缩小也不允许换行撑高整列
        maxLines: 1,
        minScale: 0.6
      },
      {
        type: 'text',
        text: unit,
        font: { size: unitSize },
        textColor: C.muted,
        maxLines: 1,
        minScale: 0.6
      }
    ]
  });

  // ---------- 错误态 ----------
  if (d.error) {
    return {
      type: 'widget',
      padding: 16,
      gap: 8,
      ...bg,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 8,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:exclamationmark.triangle.fill',
              color: C.temp,
              width: 20,
              height: 20
            },
            {
              type: 'text',
              text: '连接失败',
              font: { size: 'headline', weight: 'bold' },
              textColor: C.text
            }
          ]
        },
        {
          type: 'text',
          text: d.error,
          font: { size: 'caption1' },
          textColor: C.muted,
          maxLines: 4
        }
      ]
    };
  }

  const worstPct = Math.max(d.cpuPct, d.memPct, d.diskPct);
  const statusColor = pctColor(worstPct);
  const statusText = worstPct >= 85 ? 'Critical' : worstPct >= 60 ? 'Busy' : 'Online';

  const flag = ctx.env.flag || '';
  const displayName = ctx.env.displayName || d.hostname;

  // ---------- 锁屏 ----------
  if (ctx.widgetFamily === 'accessoryInline') {
    return {
      type: 'widget',
      children: [{ type: 'text', text: `${d.hostname}  CPU ${d.cpuPct}%  MEM ${d.memPct}%` }]
    };
  }

  if (ctx.widgetFamily === 'accessoryCircular') {
    return {
      type: 'widget',
      padding: 4,
      children: [
        { type: 'spacer' },
        {
          type: 'text',
          text: `${d.cpuPct}%`,
          font: { size: 'title2', weight: 'bold' },
          textAlign: 'center',
          textColor: C.text
        },
        {
          type: 'text',
          text: 'CPU',
          font: { size: 'caption2' },
          textAlign: 'center',
          textColor: C.muted
        },
        { type: 'spacer' }
      ]
    };
  }

  if (ctx.widgetFamily === 'accessoryRectangular') {
    return {
      type: 'widget',
      gap: 3,
      ...bg,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:server.rack',
              color: C.cpu,
              width: 11,
              height: 11
            },
            {
              type: 'text',
              text: displayName,
              font: { size: 'headline', weight: 'bold' },
              textColor: C.text,
              maxLines: 1
            }
          ]
        },
        {
          type: 'text',
          text: `CPU ${d.cpuPct}%  MEM ${d.memPct}%  DSK ${d.diskPct}%`,
          font: { size: 11, family: 'Menlo' },
          textColor: C.text
        },
        {
          type: 'text',
          text: `↓${fmtBytes(d.rxRate)}/s  ↑${fmtBytes(d.txRate)}/s`,
          font: { size: 11, family: 'Menlo' },
          textColor: C.muted
        }
      ]
    };
  }

  // ---------- 小号 ----------
  if (ctx.widgetFamily === 'systemSmall') {
    return {
      type: 'widget',
      padding: 10,
      gap: 6,
      ...bg,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          children: [
            flag
              ? { type: 'text', text: flag, font: { size: 14 } }
              : {
                  type: 'image',
                  src: 'sf-symbol:server.rack',
                  color: C.cpu,
                  width: 12,
                  height: 12
                },
            {
              type: 'text',
              text: displayName,
              font: { size: 'caption1', weight: 'bold' },
              textColor: C.text,
              maxLines: 1,
              minScale: 0.8
            },
            { type: 'spacer' },
            {
              type: 'image',
              src: 'sf-symbol:circle.fill',
              color: statusColor,
              width: 7,
              height: 7
            }
          ]
        },
        {
          type: 'stack',
          direction: 'row',
          children: [
            { type: 'spacer' },
            gauge('CPU', d.cpuPct, 64),
            { type: 'spacer' }
          ]
        },
        {
          type: 'stack',
          direction: 'row',
          children: [
            { type: 'spacer' },
            {
              type: 'stack',
              direction: 'row',
              alignItems: 'center',
              gap: 14,
              children: [
                specItem('memorychip', `${d.memPct}%`, 12),
                specItem('internaldrive', `${d.diskPct}%`, 12)
              ]
            },
            { type: 'spacer' }
          ]
        }
      ]
    };
  }

  // ---------- 中号（数值已按你调好的效果写死，不再依赖环境变量） ----------
  if (ctx.widgetFamily === 'systemMedium') {
    // 三处间距，对应之前截图中标注的 1 / 2 / 3：
    //   1) 标题行 → 规格行
    //   2) 规格行 → 分隔线
    //   3) 分隔线 → 主内容行 (CPU/RAM/NET/DISK)
    const gapTitleToSpec   = 3;
    // 说明：分隔线偏上是因为两行文字本身的字体行高（上下留白）不对称，
    // 并非这两个间距值本身导致的。要在总间距不变的前提下让线居中，
    // 只能把线两侧留白的分配比例改一改——这必然会让下面一行内容跟着挪几个点，
    // 这里做的是"往下移一点点、接近居中"和"CPU/RAM/NET/DISK 行完全不挪动"之间的折中。
    const gapSpecToDivider = 5;
    const gapDividerToMain = 0;

    // CPU/RAM 圆环直径；圆环内字体、NET/DISK 数值与单位字体固定为默认值。
    const medGaugeSize     = 55;
    const medGaugeFontSize = 12;
    const medStatValueFontSize = 12;
    const medStatUnitFontSize  = 11;
    const medStatIconSize      = 12; // 图标大小固定，不随字体变化，避免图标忽大忽小

    // 标题行与组件上边缘的间距、CPU/RAM/NET/DISK 标题行与下方内容行的间距。
    const medTopPadding      = 18;
    const medLabelToContentGap = 0;

    // 内容行的统一高度：取"圆环直径"与"NET/DISK 两行文字块的高度"中较大的一个，
    // 这样无论圆环多大，四列都能在同一个行高里垂直居中，顶部/底部始终对齐。
    const statLineHeight = 22; // 单行（图标+数值+单位）预留的高度，固定值
    const statGap = 6; // ↑/↓（或 R/W）两行之间的间距
    const statBlockHeight = statLineHeight * 2 + statGap;
    const mainRowHeight = Math.max(medGaugeSize, statBlockHeight);

    // 内容行里每一列的容器：固定 mainRowHeight 高度，内容用一对弹性 spacer 夹住，
    // 天然垂直居中，字体变大变小只会改变 spacer 分到的空间，不会改变整列的高度和对齐点。
    const contentCell = content => ({
      type: 'stack',
      direction: 'column',
      flex: 1,
      height: mainRowHeight,
      alignItems: 'center',
      children: [
        { type: 'spacer' },
        content,
        { type: 'spacer' }
      ]
    });

    // NET/DISK 专用容器：第一行贴在这一列的最上端（对齐上面那条参考线）。
    // 中间用固定长度 statGap（即 medStatRowGap）撑开，不再是弹性 spacer。
    // 好处：调这个变量立刻生效，不受圆环直径的下限影响。
    // 代价：如果圆环直径比这两行内容还高（mainRowHeight 由圆环决定），
    // 第二行（↓ / W）就不会再紧贴这一列的最下端，中间会多出一截空白。
    const edgePinnedCell = (topLine, bottomLine) => ({
      type: 'stack',
      direction: 'column',
      flex: 1,
      height: mainRowHeight,
      alignItems: 'center',
      children: [
        topLine,
        { type: 'spacer', length: statGap },
        bottomLine
      ]
    });

    // 共享标题格：CPU/RAM/NET/DISK 四个标题放进同一行的等宽格子里，天然顶部对齐。
    const columnLabel = text => ({
      type: 'stack',
      flex: 1,
      alignItems: 'center',
      children: [
        {
          type: 'text',
          text,
          font: { size: 'caption1', weight: 'medium' },
          textColor: C.dim
        }
      ]
    });

    return {
      type: 'widget',
      // 竖直方向的内边距改用显式 spacer 控制（见 children 首尾），
      // 这里只保留左右内边距；padding 的竖直分量固定为 0。
      padding: [0, 14],
      // 原本 gap:5 统一作用于所有相邻子元素之间。
      // 这里把 gap 改为 0，用显式 spacer 精确控制每一段间距。
      gap: 0,
      ...bg,
      children: [
        // ⓪ 组件上边缘 → 标题行
        { type: 'spacer', length: medTopPadding },

        // 标题行
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 6,
          children: [
            flag
              ? { type: 'text', text: flag, font: { size: 16 } }
              : {
                  type: 'image',
                  src: 'sf-symbol:server.rack',
                  color: C.text,
                  width: 15,
                  height: 15
                },
            {
              type: 'text',
              text: displayName,
              font: { size: 'subheadline', weight: 'bold' },
              textColor: C.text,
              maxLines: 1
            },
            { type: 'spacer' },
            {
              type: 'image',
              src: 'sf-symbol:circle.fill',
              color: statusColor,
              width: 7,
              height: 7
            },
            {
              type: 'text',
              text: statusText,
              font: { size: 'caption2', weight: 'medium' },
              textColor: C.text
            }
          ]
        },

        // ① 标题行 → 规格行
        { type: 'spacer', length: gapTitleToSpec },

        // 规格行
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          children: [
            specItem('cpu', `${d.cores} Cores`, 10),
            { type: 'spacer' },
            specItem('memorychip', fmtBytes(d.memTotal), 10),
            { type: 'spacer' },
            specItem('internaldrive', fmtBytes(d.diskTotal), 10),
            { type: 'spacer' },
            specItem('power', `${d.uptimeDays}d`, 10)
          ]
        },

        // ② 规格行 → 分隔线（Cores 这一行 和 下方 CPU/RAM/NET/DISK 标题行之间的灰色细线）
        { type: 'spacer', length: gapSpecToDivider },

        hDivider(),

        // ③ 分隔线 → 标题行(CPU/RAM/NET/DISK)
        { type: 'spacer', length: gapDividerToMain },

        // 共享标题行：CPU / RAM / NET / DISK 四个标题在同一行里，天然对齐
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          children: [
            columnLabel('CPU'),
            columnLabel('RAM'),
            columnLabel('NET'),
            columnLabel('DISK')
          ]
        },

        // ④ 标题行(CPU/RAM/NET/DISK) → 内容行
        { type: 'spacer', length: medLabelToContentGap },

        // 共享内容行：四列统一高度 mainRowHeight。
        // CPU/RAM 用 contentCell 整体居中（圆环本身就撑满行高，天然贴合上下参考线）；
        // NET/DISK 用 edgePinnedCell，两行数值分别死死顶住这一列的最上端和最下端，
        // 不会因为某个数值变长/变短而整体上下漂移。
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 6,
          children: [
            // CPU
            contentCell(
              gaugeCircleOnly(d.cpuPct, medGaugeSize, medGaugeFontSize)
            ),
            // RAM
            contentCell(
              gaugeCircleOnly(d.memPct, medGaugeSize, medGaugeFontSize)
            ),
            // NET：↑ 行死死顶在最上端，↓ 行死死顶在最下端
            edgePinnedCell(
              statLine('arrow.up.circle', ...fmtBytesParts(d.txRate), medStatValueFontSize, medStatIconSize, medStatUnitFontSize, statLineHeight),
              statLine('arrow.down.circle', ...fmtBytesParts(d.rxRate), medStatValueFontSize, medStatIconSize, medStatUnitFontSize, statLineHeight)
            ),
            // DISK：R 行死死顶在最上端，W 行死死顶在最下端
            edgePinnedCell(
              statLine('r.circle', ...fmtBytesParts(d.diskRd), medStatValueFontSize, medStatIconSize, medStatUnitFontSize, statLineHeight),
              statLine('w.circle', ...fmtBytesParts(d.diskWr), medStatValueFontSize, medStatIconSize, medStatUnitFontSize, statLineHeight)
            )
          ]
        },

        // ⑤ 内容行 → 组件下边缘（保持原有间距不变）
        { type: 'spacer', length: 18 }
      ]
    };
  }

  // ---------- 大号 ----------
  return {
    type: 'widget',
    padding: 16,
    gap: 12,
    ...bg,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 8,
        children: [
          flag
            ? { type: 'text', text: flag, font: { size: 24 } }
            : {
                type: 'image',
                src: 'sf-symbol:server.rack',
                color: C.text,
                width: 24,
                height: 24
              },
          {
            type: 'text',
            text: displayName,
            font: { size: 22, weight: 'bold' },
            textColor: C.text,
            maxLines: 1
          },
          { type: 'spacer' },
          {
            type: 'image',
            src: 'sf-symbol:circle.fill',
            color: statusColor,
            width: 9,
            height: 9
          },
          {
            type: 'text',
            text: statusText,
            font: { size: 'subheadline', weight: 'medium' },
            textColor: C.text
          }
        ]
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        children: [
          specItem('cpu', `${d.cores} Cores`),
          { type: 'spacer' },
          specItem('memorychip', fmtBytes(d.memTotal)),
          { type: 'spacer' },
          specItem('internaldrive', fmtBytes(d.diskTotal)),
          { type: 'spacer' },
          specItem('power', `${d.uptimeDays} Days`)
        ]
      },
      // 规格行 与 CPU/RAM 圆环行之间的灰色细线
      hDivider(),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 16,
        children: [
          gauge('CPU', d.cpuPct),
          gauge('RAM', d.memPct),
          {
            type: 'stack',
            direction: 'column',
            flex: 1,
            gap: 10,
            children: [
              {
                type: 'text',
                text: 'Network',
                font: { size: 'subheadline', weight: 'medium' },
                textColor: C.dim
              },
              statLine('arrow.up.circle', ...fmtBytesParts(d.txRate)),
              statLine('arrow.down.circle', ...fmtBytesParts(d.rxRate))
            ]
          },
          {
            type: 'stack',
            direction: 'column',
            flex: 1,
            gap: 10,
            children: [
              {
                type: 'text',
                text: 'Disk',
                font: { size: 'subheadline', weight: 'medium' },
                textColor: C.dim
              },
              statLine('r.circle', ...fmtBytesParts(d.diskRd)),
              statLine('w.circle', ...fmtBytesParts(d.diskWr))
            ]
          }
        ]
      }
    ]
  };
}

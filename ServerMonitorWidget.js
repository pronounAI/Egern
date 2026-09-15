// Server Monitor Widget for Egern (自适应深浅色 + 纯透明模式)
// 环境变量：
//   host, username, password 或 privateKey, port（默认 22）
//   glass       = 1/true/yes/on → 完全透明模式，不设置任何背景（默认关闭，使用渐变深色/浅色背景）
//   flag        = 任意 emoji，如 🇸🇬  → 大号组件标题栏左侧显示的国旗/图标（默认显示服务器图标）
//   displayName = 自定义名称，如 "Oracle Singapore" → 大号组件标题（默认使用主机名）

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
    divider:{ light: '#0000001A', dark: '#FFFFFF1F' },
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

  const bg = glass
    ? {}
    : {
        backgroundGradient: {
          type: 'linear',
          colors: [
            { light: '#F8F9FB', dark: '#0D0D0F' },
            { light: '#EDEEF2', dark: '#1C1C1E' }
          ],
          startPoint: { x: 0, y: 0 },
          endPoint: { x: 1, y: 1 }
        }
      };

  // ---------- 通用组件 ----------
  const hDivider = () => ({
    type: 'stack',
    height: 1,
    backgroundColor: C.divider,
    children: []
  });

  const gaugeSvg = pct => {
    const p = Math.max(0, Math.min(100, pct));
    const r = 40;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - p / 100);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<defs>` +
      `<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">` +
      `<stop offset="0%" stop-color="#0A84FF"/>` +
      `<stop offset="100%" stop-color="#30D158"/>` +
      `</linearGradient>` +
      `</defs>` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#8E8E9355" stroke-width="9"/>` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#g)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 50 50)"/>` +
      `</svg>`;

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  const gauge = (label, pct, size = 76) => ({
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
            font: { size: 12, weight: 'bold', family: 'Menlo' },
            textColor: { light: '#000000', dark: '#FFFFFF' },
            textAlign: 'center'
          },
          { type: 'spacer' }
        ]
      }
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

  const statLine = (icon, value, unit, size = 16) => ({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      {
        type: 'image',
        src: `sf-symbol:${icon}`,
        color: C.dim,
        width: size - 1,
        height: size - 1
      },
      {
        type: 'text',
        text: value,
        font: { size, weight: 'bold', family: 'Menlo' },
        textColor: C.text
      },
      {
        type: 'text',
        text: unit,
        font: { size: 11 },
        textColor: C.muted
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

  // ---------- 中号（最终调整版） ----------
  if (ctx.widgetFamily === 'systemMedium') {
    return {
      type: 'widget',
      padding: [18, 14],
      // 原本 gap:5 统一作用于所有相邻子元素之间。
      // 为了让"标题行→规格行"单独多出 4pt、同时不影响规格行以下内容的绝对位置，
      // 这里把 gap 改为 0，用显式 spacer 精确还原/调整每一段间距。
      gap: 0,
      ...bg,
      children: [
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

        // 标题行 → 规格行：原 gap(5) + 4pt，让规格行整体下移约 4pt
        { type: 'spacer', length: 16 },

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

        // 规格行 → 分隔线：原 gap(5) - 4pt，抵消上面多加的 4pt，
        // 使分隔线及其后所有内容的绝对位置与调整前完全一致
        { type: 'spacer', length: 1 },

        hDivider(),

        // 分隔线 → 主内容行：等价于原来的 gap(5) + 显式 spacer(4) + gap(5)，位置保持不变
        { type: 'spacer', length: 14 },

        // 主内容行：四列等宽，顶部对齐
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'start',
          gap: 6,
          children: [
            // CPU
            {
              type: 'stack',
              direction: 'column',
              flex: 1,
              alignItems: 'center',
              children: [
                gauge('CPU', d.cpuPct, 48)
              ]
            },
            // RAM
            {
              type: 'stack',
              direction: 'column',
              flex: 1,
              alignItems: 'center',
              children: [
                gauge('RAM', d.memPct, 48)
              ]
            },
            // NET
            {
              type: 'stack',
              direction: 'column',
              flex: 1,
              gap: 9,
              alignItems: 'center',
              children: [
                {
                  type: 'text',
                  text: 'NET',
                  font: { size: 'caption1', weight: 'medium' },
                  textColor: C.dim
                },
                statLine('arrow.up.circle', ...fmtBytesParts(d.txRate), 12),
                statLine('arrow.down.circle', ...fmtBytesParts(d.rxRate), 12)
              ]
            },
            // DISK
            {
              type: 'stack',
              direction: 'column',
              flex: 1,
              gap: 9,
              alignItems: 'center',
              children: [
                {
                  type: 'text',
                  text: 'DISK',
                  font: { size: 'caption1', weight: 'medium' },
                  textColor: C.dim
                },
                statLine('r.circle', ...fmtBytesParts(d.diskRd), 12),
                statLine('w.circle', ...fmtBytesParts(d.diskWr), 12)
              ]
            }
          ]
        }
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

// =====================================================================
// e2e.mjs —— TabVault 端到端验收测试（零依赖，Node ≥ 22）
//
// 原理：启动一个独立临时配置文件的 Chrome（--load-extension 加载本扩展，
// --remote-debugging-port 开 CDP），通过 CDP 驱动：
//   1. 在 chrome://extensions 页用 developerPrivate 确认扩展加载无错误
//   2. 把 popup.html 作为标签页打开（扩展页面拥有完整 chrome.* 权限）
//   3. 程序化构造场景（3 分组其一折叠 + 散标签 + pinned + 系统页），
//      逐条验证需求 §6 验收标准与 §8 边界行为
//   4. 收集页面控制台异常
//
// 用法：node tools/e2e.mjs
// =====================================================================
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXT_PATH = ROOT;                 // manifest.json 位于仓库根目录
const PORT = 9223;
const SAMPLE_FILE = join(ROOT, 'samples', 'tabvault-sample.json');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Catsxp/Application/catsxp.exe',
  join(process.env.LOCALAPPDATA || '', 'Catsxp/Application/catsxp.exe'),
].filter(Boolean);

/* ------------------------------ 小工具 ------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(path, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { retry(left, e); }
        });
      });
      req.on('error', (e) => retry(left, e));
    };
    const retry = async (left, err) => {
      if (left <= 0) return reject(new Error('CDP 端口不可用: ' + err.message));
      await sleep(500);
      attempt(left - 1);
    };
    attempt(tries);
  });
}

/* 极简 CDP 客户端（基于 Node 22 全局 WebSocket） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(method + ' 失败: ' + msg.error.message));
        else resolve(msg.result);
      } else {
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) { this.listeners.add(fn); }
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + url)));
  });
}

/* 在指定会话里执行 JS 并返回值（自动等待 Promise） */
async function evalJs(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const text = d.exception && d.exception.description ? d.exception.description : JSON.stringify(d);
    throw new Error('页面脚本执行出错: ' + text.slice(0, 1500));
  }
  return r.result.value;
}

/* 轮询执行页面表达式直到返回真值（导航初期执行上下文可能暂不可用，忽略并重试） */
async function waitFor(cdp, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await evalJs(cdp, sessionId, expression);
      if (v) return v;
    } catch (e) { /* 上下文切换中，稍后重试 */ }
    await sleep(200);
  }
  return null;
}

/* 未打包扩展的 ID = 绝对路径 SHA256 前 32 位 hex 映射到 a-p（与 Chrome GenerateIdForPath 同算法） */
function unpackedId(pathStr) {
  const hex = createHash('sha256').update(pathStr).digest('hex').slice(0, 32);
  let id = '';
  for (const c of hex) id += String.fromCharCode(97 + parseInt(c, 16));
  return id;
}

/* 创建标签页目标并附加（flatten 会话） */
async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  for (let i = 0; i < 40; i++) {
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, sessionId };
    } catch (e) { await sleep(250); }
  }
  throw new Error('附加目标失败: ' + url);
}

/* ------------------------------ 断言 ------------------------------ */
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass ? '' : '  —— ' + detail));
}
const jstr = (v) => JSON.stringify(v);
const eq = (a, b) => jstr(a) === jstr(b);

/* ------------------------------ 页内脚本片段 ------------------------------ */
/* 现场视图：把窗口当前 tabs/groups 汇总成与快照可比的结构 */
const JS_LV = `
(async () => {
  async function lv(windowId) {
    const tabs = await chrome.tabs.query({ windowId: windowId });
    const groups = await chrome.tabGroups.query({ windowId: windowId });
    const real = tabs.filter(function (t) { return t.url.indexOf('chrome-extension://') !== 0; });
    const byGroup = {};
    const pinned = [];
    const loose = [];
    real.forEach(function (t) {
      if (t.pinned) { pinned.push(t); return; }
      if (typeof t.groupId === 'number' && t.groupId !== -1) {
        if (!byGroup[t.groupId]) byGroup[t.groupId] = [];
        byGroup[t.groupId].push(t);
      } else { loose.push(t); }
    });
    const ordered = groups.slice().sort(function (a, b) {
      const ma = Math.min.apply(null, (byGroup[a.id] || []).map(function (t) { return t.index; }));
      const mb = Math.min.apply(null, (byGroup[b.id] || []).map(function (t) { return t.index; }));
      return ma - mb;
    });
    return {
      pinnedUrls: pinned.map(function (t) { return t.url || t.pendingUrl || ''; }),
      groups: ordered.filter(function (g) { return (byGroup[g.id] || []).length > 0; }).map(function (g) {
        return { title: g.title, color: g.color, collapsed: g.collapsed,
                 urls: byGroup[g.id].map(function (t) { return t.url || t.pendingUrl || ''; }) };
      }),
      looseUrls: loose.map(function (t) { return t.url || t.pendingUrl || ''; })
    };
  }
  window.__lv = lv;
  return await lv(WINDOW_ID);
})()`;

/* 快照 → 与现场视图同构的结构 */
const JS_SNAPVIEW = `
(function () {
  window.__snapView = function (snap) {
    const pinnedUrls = []; const looseUrls = []; const groups = [];
    (snap.groups || []).forEach(function (g) {
      (g.tabs || []).forEach(function (t) { if (t.pinned) pinnedUrls.push(t.url); });
      if (g.unnamed) {
        (g.tabs || []).forEach(function (t) { if (!t.pinned) looseUrls.push(t.url); });
      } else {
        groups.push({ title: g.title, color: g.color, collapsed: !!g.collapsed,
          urls: (g.tabs || []).filter(function (t) { return !t.pinned; }).map(function (t) { return t.url; }) });
      }
    });
    return { pinnedUrls: pinnedUrls, groups: groups, looseUrls: looseUrls };
  };
  return true;
})()`;

/* 用产品自身的 isSaveableUrl 剔除系统页（与保存逻辑完全同源） */
const JS_STRIP = `
(function () {
  window.__strip = function (view) {
    return {
      pinnedUrls: view.pinnedUrls.filter(isSaveableUrl),
      groups: view.groups.map(function (g) {
        return { title: g.title, color: g.color, collapsed: g.collapsed,
                 urls: g.urls.filter(isSaveableUrl) };
      }).filter(function (g) { return g.urls.length > 0; }),
      looseUrls: view.looseUrls.filter(isSaveableUrl)
    };
  };
  return true;
})()`;

/* 构造验收标准 §6.1 的场景：3 分组（其一折叠）+ 2 散标签 + 1 pinned + 系统页 */
const JS_SCENARIO = `
(async () => {
  const win = await chrome.windows.getCurrent();
  const windowId = win.id;
  function mk(url, extra) {
    return chrome.tabs.create(Object.assign({ windowId: windowId, url: url, active: false }, extra || {}));
  }
  await mk('https://example.com/?p=mail', { pinned: true });
  let sysCreated = true;
  try { await mk('about:blank'); } catch (e) { sysCreated = false; }
  const g1 = [await mk('https://example.com/?g1a'), await mk('https://example.com/?g1b')];
  const g2 = [await mk('https://example.com/?g2a')];
  const g3 = [await mk('https://example.com/?g3a'), await mk('https://example.com/?g3b'), await mk('https://example.com/?g3c')];
  await mk('https://example.com/?loose1');
  await mk('https://example.com/?loose2');
  const gid1 = await chrome.tabs.group({ tabIds: g1.map(t => t.id), createProperties: { windowId: windowId } });
  const gid2 = await chrome.tabs.group({ tabIds: g2.map(t => t.id), createProperties: { windowId: windowId } });
  const gid3 = await chrome.tabs.group({ tabIds: g3.map(t => t.id), createProperties: { windowId: windowId } });
  await chrome.tabGroups.update(gid1, { title: '工作', color: 'blue', collapsed: false });
  await chrome.tabGroups.update(gid2, { title: '资讯', color: 'red', collapsed: true });
  await chrome.tabGroups.update(gid3, { title: '购物', color: 'green', collapsed: false });
  return { windowId: windowId, sysCreated: sysCreated };
})()`;

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chromePath) throw new Error('未找到 Chrome/Catsxp，请安装后重试');

  const profile = mkdtempSync(join(tmpdir(), 'tabvault-e2e-'));
  const dlDir = join(profile, 'downloads');
  mkdirSync(dlDir, { recursive: true });

  let proc = null;
  let bws = null;
  const consoleErrors = [];

  try {
    /* 1. 启动浏览器 */
    proc = spawn(chromePath, [
      '--user-data-dir=' + profile,
      '--load-extension=' + EXT_PATH,
      '--remote-debugging-port=' + PORT,
      '--no-first-run', '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--window-size=1200,900',
      'about:blank',
    ], { stdio: 'ignore' });
    console.log('已启动浏览器:', chromePath);

    const version = await httpGetJson('/json/version');
    bws = await connectWS(version.webSocketDebuggerUrl);
    console.log('CDP 已连接:', version.Browser);

    /* 下载目录定向到临时目录（避免污染用户 Downloads） */
    await bws.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    /* 2. 确认扩展加载状态（chrome://extensions 的 WebUI API；先等页面与 API 绑定就绪） */
    let info = null;
    let extPage = null;
    try {
      extPage = await openTab(bws, 'chrome://extensions/');
      info = await waitFor(bws, extPage.sessionId, `
        (async () => {
          if (!location.href.startsWith('chrome://extensions')) return null;
          if (!window.chrome || !chrome.developerPrivate) return null;
          return await new Promise((res) => chrome.developerPrivate.getExtensionsInfo((list) => {
            const e = list.find((x) => x.name === '标签保险箱');
            res(e ? { id: e.id, state: e.state, version: e.version,
                      manifestErrors: e.manifestErrors, runtimeErrors: e.runtimeErrors } : null);
          }));
        })()
      `, 20000);
    } catch (e) { info = null; }

    /* 扩展 ID：优先取 Chrome 实际分配的；不可用时按路径推导 */
    const extId = (info && info.id) || unpackedId(EXT_PATH);
    if (info) {
      check('扩展已加载且启用', info.state === 'ENABLED', jstr(info));
      check('manifest 无加载错误', info.manifestErrors.length === 0, jstr(info.manifestErrors));
      check('无运行时错误', info.runtimeErrors.length === 0, jstr(info.runtimeErrors));
      check('扩展版本 1.0.0', info.version === '1.0.0', info.version);
    } else {
      check('developerPrivate 可用（不可用时按路径推导 ID）', false, 'chrome://extensions WebUI API 未就绪');
    }
    if (extPage) {
      await bws.send('Target.closeTarget', { targetId: extPage.targetId }).catch(() => {});
    }

    /* 3. 打开 popup 页面（作为标签页，拥有完整扩展权限），等待初始化完成 */
    const popup = await openTab(bws, 'chrome-extension://' + extId + '/popup.html');
    const sid = popup.sessionId;
    await bws.send('Runtime.enable', {}, sid);
    await bws.send('Log.enable', {}, sid);
    bws.on((msg) => {
      if (msg.sessionId !== sid) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push((msg.params.exceptionDetails.exception &&
          msg.params.exceptionDetails.exception.description) || jstr(msg.params.exceptionDetails));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        consoleErrors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
      }
    });

    const pageReady = await waitFor(bws, sid,
      'typeof saveCurrentWindow === "function" && !!document.getElementById("list")', 15000);
    check('popup 页面与脚本就绪', pageReady === true, jstr(pageReady));

    /* 4. 清场：移除窗口内预置标签（企业策略可能预置启动页），保证场景确定性 */
    const removed = await evalJs(bws, sid, `
      (async () => {
        const me = await chrome.tabs.getCurrent();
        const win = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: win.id });
        const others = tabs.filter((t) => t.id !== me.id).map((t) => t.id);
        if (others.length) await chrome.tabs.remove(others);
        return others.length;
      })()
    `);
    const remainingTabs = await evalJs(bws, sid, `
      (async () => {
        const win = await chrome.windows.getCurrent();
        return (await chrome.tabs.query({ windowId: win.id })).length;
      })()
    `);
    check('测试窗口已隔离（预置标签已移除，仅剩 popup 页）',
      remainingTabs === 1, 'removed=' + removed + ' remaining=' + remainingTabs);

    /* 5. 场景构造（3 组其一折叠 + 2 散标签 + 1 pinned + 1 系统页）并等待稳定 */
    await evalJs(bws, sid, JS_SNAPVIEW);
    await evalJs(bws, sid, JS_STRIP);
    const scenario = await evalJs(bws, sid, JS_SCENARIO);
    const winId = scenario.windowId;
    await evalJs(bws, sid, JS_LV.replace('WINDOW_ID', String(winId)));
    const settledOk = await waitFor(bws, sid,
      '(async () => { const v = await window.__lv(' + winId + ');' +
      ' return v.pinnedUrls.length === 1 && v.groups.length === 3 && v.looseUrls.length === 3; })()', 10000);
    const liveBefore = await evalJs(bws, sid, 'window.__lv(' + winId + ')');
    check('场景构造完成（3 组 + 2 散标签 + 1 pinned + 1 系统页）',
      settledOk && liveBefore.groups.length === 3 &&
      liveBefore.pinnedUrls.length === 1 && liveBefore.looseUrls.length === 3,
      jstr(liveBefore));

    /* ---- §6.1 保存侧：快照结构 == 现场（剔除系统页） ----
     * 浏览器窗口对使用者可见（可能被手动操作），因此：
     * - 保存前后做 id 差集，锁定本次保存产生的快照；
     * - 系统页计数与保存在同一段页面脚本内完成，避免时间差。 */
    const beforeIds = await evalJs(bws, sid,
      '(async () => (await chrome.storage.local.get("snapshots")).snapshots.map((s) => s.id))()');
    const saved = await evalJs(bws, sid, `
      (async () => {
        const win = await chrome.windows.getCurrent();
        let skippedNow = 0;
        (await chrome.tabs.query({ windowId: win.id })).forEach((t) => {
          if ((t.url || '').indexOf('chrome-extension://') === 0) return;
          if (!isSaveableUrl(t.url || t.pendingUrl || '')) skippedNow++;
        });
        await saveCurrentWindow();
        const data = await chrome.storage.local.get('snapshots');
        return { skippedNow, list: data.snapshots,
                 status: document.getElementById('status').textContent };
      })()
    `);
    const expectedSaved = await evalJs(bws, sid, 'window.__strip(' + jstr(liveBefore) + ')');
    const beforeIdSet = new Set(beforeIds);
    const newlyAdded = saved.list.filter((s) => !beforeIdSet.has(s.id));
    const snap0 = newlyAdded.find((s) => (s.groups || []).length === 3) || newlyAdded[newlyAdded.length - 1];
    check('保存后快照入列（新的在前）', !!snap0,
      '本次新增=' + newlyAdded.length + ' 总数=' + saved.list.length);
    const snap0View = snap0 ? await evalJs(bws, sid, 'window.__snapView(' + jstr(snap0) + ')') : null;
    check('§6.1 快照结构与现场一致（分组名/色/折叠/组内顺序/pinned/散标签）',
      eq(snap0View, expectedSaved),
      'expected=' + jstr(expectedSaved) + ' actual=' + jstr(snap0 && snap0.groups));
    check('自动命名格式 YYYY-MM-DD HH:mm',
      !!snap0 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(snap0.name),
      snap0 && snap0.name);
    /* 反馈文案：数字必须与快照实际内容一致（系统页数以保存瞬间为准，
     * 使用者可能正手动操作窗口，故不做瞬时精确比对） */
    const m = (saved.status || '').match(/^已保存 (\d+) 个标签、(\d+) 个分组（另有 (\d+) 个系统页未保存）$/);
    const snapTotalTabs = snap0 ? snap0.groups.reduce((s, g) => s + g.tabs.length, 0) : -1;
    const snapNamedGroups = snap0 ? snap0.groups.filter((g) => !g.unnamed).length : -1;
    check('§8/F1 保存反馈文案（数字与快照内容一致、含系统页跳过说明）',
      !!m && Number(m[1]) === snapTotalTabs && Number(m[2]) === snapNamedGroups && Number(m[3]) >= 1,
      'status=' + saved.status + ' snapTabs=' + snapTotalTabs + ' snapGroups=' + snapNamedGroups);
    const myId = snap0 && snap0.id;

    /* ---- §6.5 重命名 ---- */
    const renamed = await evalJs(bws, sid, `
      (async () => {
        const okRename = await renameSnapshotById(${jstr(myId)}, '测试快照A');
        const after = await chrome.storage.local.get('snapshots');
        const target = after.snapshots.find((s) => s.id === ${jstr(myId)});
        const card = document.querySelector('.card[data-id="${myId}"] .card-name');
        return { okRename, name: target ? target.name : null, cardText: card ? card.textContent : null };
      })()
    `);
    check('§6.5 重命名生效（storage + 列表刷新）',
      renamed.okRename === true && renamed.name === '测试快照A' && renamed.cardText === '测试快照A',
      jstr(renamed));

    /* 行内编辑 UI 交互：进入编辑 → 输入 → 回车 → 就地恢复 + 保存（§4） */
    const uiRename = await evalJs(bws, sid, `
      (async () => {
        const data = await chrome.storage.local.get('snapshots');
        const target = data.snapshots.find((s) => s.id === ${jstr(myId)});
        const nameEl = document.querySelector('.card[data-id="${myId}"] .card-name');
        startRename(target, nameEl);
        const input = document.querySelector('.rename-input');
        if (!input) return { ok: false, why: '输入框未出现' };
        input.value = '界面改名测试';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const after = await chrome.storage.local.get('snapshots');
        const t2 = after.snapshots.find((s) => s.id === ${jstr(myId)});
        const nameEl2 = document.querySelector('.card[data-id="${myId}"] .card-name');
        return { ok: !!(t2 && t2.name === '界面改名测试' && nameEl2 &&
                         nameEl2.textContent === '界面改名测试') };
      })()
    `);
    check('§4 行内重命名 UI 交互（回车保存 + 就地恢复显示）',
      uiRename.ok === true, jstr(uiRename));

    /* ---- §6.3 恢复：先关掉全部其它标签，再恢复并比对 ---- */
    const closed = await evalJs(bws, sid, `
      (async () => {
        const me = await chrome.tabs.getCurrent();
        const win = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: win.id });
        const others = tabs.filter((t) => t.id !== me.id).map((t) => t.id);
        await chrome.tabs.remove(others);
        const rest = await chrome.tabs.query({ windowId: win.id });
        return rest.length;
      })()
    `);
    check('恢复前已关闭场景标签（仅剩 popup 页）', closed === 1, 'remaining=' + closed);

    const restored = await evalJs(bws, sid, `
      (async () => {
        const data = await chrome.storage.local.get('snapshots');
        const snap = data.snapshots.find((s) => s.id === ${jstr(myId)});
        await restoreSnapshot(snap);
        await new Promise((r) => setTimeout(r, 600));   // 等待标签 URL 提交稳定
        const win = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: win.id });
        return {
          status: document.getElementById('status').textContent,
          tabCount: tabs.length,
          live: await window.__lv(win.id),
          snapV: window.__snapView(snap),
          totalTabs: snap.groups.reduce((s, g) => s + g.tabs.length, 0),
        };
      })()
    `);
    check('§6.1/§6.3 恢复后结构完全一致（名/色/折叠/组内顺序/pinned 在最前/散标签仍散）',
      eq(restored.live, restored.snapV),
      'live=' + jstr(restored.live) + ' snap=' + jstr(restored.snapV));
    check('§6.3 恢复不关闭现有标签（popup 页仍在），标签数 = 快照数 + 1',
      restored.tabCount === restored.totalTabs + 1,
      'tabCount=' + restored.tabCount + ' totalTabs=' + restored.totalTabs);
    check('§6.3 恢复反馈"已恢复 N 个标签"',
      restored.status === '已恢复 ' + restored.totalTabs + ' 个标签',
      'status=' + restored.status);

    /* ---- §6.4 导入：示例文件（2 条）→ 导出全部 → 清空 → 再导入 → 比对 ---- */
    const sampleText = readFileSync(SAMPLE_FILE, 'utf8');
    const import1 = await evalJs(bws, sid, `
      (async () => {
        const before = (await chrome.storage.local.get('snapshots')).snapshots.length;
        await importFromFile(new File([${jstr(sampleText)}], 'sample.json', { type: 'application/json' }));
        const data = await chrome.storage.local.get('snapshots');
        return { before, after: data.snapshots.length,
                 status: document.getElementById('status').textContent,
                 snapshots: data.snapshots };
      })()
    `);
    check('§6.4/F4 导入示例文件成功且提示"已导入 2 条"',
      import1.after === import1.before + 2 && import1.status === '已导入 2 条',
      'before=' + import1.before + ' after=' + import1.after + ' status=' + import1.status);
    check('§5/F4 导入重新生成 id（不覆盖现有）',
      new Set(import1.snapshots.map((s) => s.id)).size === import1.snapshots.length,
      jstr(import1.snapshots.map((s) => s.id)));
    check('§4 列表按时间倒序（新的在上）',
      eq(import1.snapshots.map((s) => s.createdAt),
        import1.snapshots.map((s) => s.createdAt).slice().sort((a, b) => b - a)),
      jstr(import1.snapshots.map((s) => s.createdAt)));

    /* 非法导入：篡改结构 / 坏 JSON / 错误 format */
    const bad1 = await evalJs(bws, sid, `
      (async () => {
        const before = (await chrome.storage.local.get('snapshots')).snapshots.length;
        await importFromFile(new File(['{"format":"tabvault","version":1,"snapshots":[{"groups":42}]}'], 'bad.json', { type: 'application/json' }));
        await importFromFile(new File(['这不是JSON'], 'bad2.json', { type: 'application/json' }));
        await importFromFile(new File(['{"format":"other","version":1,"snapshots":[]}'], 'bad3.json', { type: 'application/json' }));
        const after = (await chrome.storage.local.get('snapshots')).snapshots.length;
        return { before, after, status: document.getElementById('status').textContent };
      })()
    `);
    check('§8 非法/篡改文件被拒绝且不影响现有数据',
      bad1.after === bad1.before && bad1.status.includes('拒绝'),
      'before=' + bad1.before + ' after=' + bad1.after + ' status=' + bad1.status);

    /* 导出全部 → 校验文件 → 清空 → 导入 → 比对（§6.4 完整回路）。
     * 下载目录可能被浏览器策略改写，因此从 downloads.search 结果里取实际文件路径。 */
    const exportData = await evalJs(bws, sid, `
      (async () => {
        const data = await chrome.storage.local.get('snapshots');
        await exportSnapshots(data.snapshots);
        return { list: data.snapshots, status: document.getElementById('status').textContent };
      })()
    `);
    let dlItem = null;
    for (let i = 0; i < 30 && !dlItem; i++) {
      const items = await evalJs(bws, sid,
        'chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 })');
      const hit = items.find((x) => (x.filename || '').indexOf('tabvault-') >= 0);
      if (hit && hit.state === 'complete') dlItem = hit;
      else await sleep(500);
    }
    check('F4 导出反馈并生成下载记录',
      exportData.status === '已导出到浏览器下载目录' && !!dlItem,
      'status=' + exportData.status + ' item=' + jstr(dlItem && { state: dlItem.state, filename: dlItem.filename }));
    let exported = null;
    let readErr = '';
    if (dlItem) {
      for (let i = 0; i < 20 && !exported; i++) {
        try { exported = JSON.parse(readFileSync(dlItem.filename, 'utf8')); }
        catch (e) { readErr = e.message; await sleep(1000); }
      }
    }
    check('§5 导出文件信封结构（format/version/exportedAt/snapshots）',
      !!exported && exported.format === 'tabvault' && exported.version === 1 &&
      typeof exported.exportedAt === 'string' && Array.isArray(exported.snapshots),
      exported ? jstr(Object.keys(exported)) : '文件读取失败: ' + readErr +
        ' path=' + (dlItem && dlItem.filename));
    check('F4 导出内容与存储完全一致',
      !!exported && eq(exported.snapshots, exportData.list), '');

    const beforeClear = exportData.list;
    const reimported = await evalJs(bws, sid, `
      (async () => {
        await chrome.storage.local.set({ snapshots: [] });
        snapshotsCache = [];
        renderList();
        if (!${exported ? 'true' : 'false'}) return { count: 0, snapshots: [], skipped: true };
        await importFromFile(new File([${jstr(JSON.stringify(exported))}], 'restore.json', { type: 'application/json' }));
        const data = await chrome.storage.local.get('snapshots');
        return { count: data.snapshots.length, snapshots: data.snapshots };
      })()
    `);
    const norm = (list) => list.map((s) => jstr([s.name, s.createdAt, s.groups])).sort();
    check('§6.4 清空数据后导入可完整还原（名称/时间/分组内容一致，可再次恢复）',
      reimported.count === beforeClear.length && eq(norm(reimported.snapshots), norm(beforeClear)),
      'count=' + reimported.count);

    /* ---- §6.5 删除（二次确认）+ 空列表文案 ---- */
    const deleteFlow = await evalJs(bws, sid, `
      (async () => {
        const steps = [];
        let data = await chrome.storage.local.get('snapshots');
        if (!data.snapshots.length) {
          const empty = document.getElementById('empty');
          return { steps: null, count: 0,
                   emptyShown: !empty.hidden, emptyText: empty.textContent.trim() };
        }
        const firstId = data.snapshots[0].id;
        const firstName = data.snapshots[0].name;
        askDelete(firstId);
        steps.push({ overlayShown: !document.getElementById('confirm-overlay').hidden,
                     text: document.getElementById('confirm-text').textContent,
                     name: firstName });
        closeConfirm();
        steps.push({ overlayHiddenAfterCancel: document.getElementById('confirm-overlay').hidden });
        data = await chrome.storage.local.get('snapshots');
        steps.push({ countUnchangedAfterCancel: data.snapshots.length });
        while (true) {
          data = await chrome.storage.local.get('snapshots');
          if (!data.snapshots.length) break;
          askDelete(data.snapshots[0].id);
          await confirmDelete();
        }
        const empty = document.getElementById('empty');
        return { steps, count: data.snapshots.length,
                 emptyShown: !empty.hidden, emptyText: empty.textContent.trim() };
      })()
    `);
    const ds = deleteFlow.steps;
    check('§6.5/F2 删除弹出弹窗内二次确认（含快照名）',
      !!ds && ds[0].overlayShown === true && ds[0].text.includes(ds[0].name),
      jstr(ds ? { text: ds[0].text, name: ds[0].name } : '无快照可删（导入链路失败）'));
    check('§6.5 取消删除不影响数据',
      !!ds && ds[1].overlayHiddenAfterCancel === true && ds[2].countUnchangedAfterCancel > 0,
      ds ? jstr(ds[1]) + jstr(ds[2]) : '无快照可删');
    check('§6.5/§4 删完显示空列表文案',
      deleteFlow.count === 0 && deleteFlow.emptyShown === true &&
      deleteFlow.emptyText === '还没有快照，点击上方按钮保存当前窗口',
      jstr(deleteFlow));

    /* ---- 纯函数单测：散标签开关 / 系统页判断 / 空窗口提示 ---- */
    const unit = await evalJs(bws, sid, `
      (async () => {
        const now = new Date(1789007160000);
        function fakeTabs() {
          return [
            { url: 'https://a.com', title: 'A', pinned: true, groupId: -1, index: 0 },
            { url: 'chrome://newtab/', title: '新标签页', pinned: false, groupId: -1, index: 1 },
            { url: 'https://b.com', title: 'B', pinned: false, groupId: -1, index: 2 },
            { url: 'https://c.com', title: 'C', pinned: false, groupId: 77, index: 3 },
          ];
        }
        const fakeGroups = [{ id: 77, title: 'G', color: 'purple', collapsed: false }];
        const on = buildSnapshotData(fakeTabs(), fakeGroups, { saveUngrouped: true }, now);
        const off = buildSnapshotData(fakeTabs(), fakeGroups, { saveUngrouped: false }, now);
        const onlyNewtab = buildSnapshotData(
          [{ url: 'chrome://newtab/', title: '新标签页', pinned: false, groupId: -1, index: 0 }],
          [], { saveUngrouped: true }, now);
        const urlMatrix = {};
        [['https://x.com', true], ['chrome://version/', false], ['about:blank', false],
         ['edge://newtab', false], ['file:///C:/a.txt', true], ['chrome-extension://abc/x', false],
         ['', false], ['not a url', false], ['view-source:https://x', false]]
          .forEach(([u, want]) => { urlMatrix[u] = isSaveableUrl(u) === want; });
        const v1 = validateExportPayload({ format: 'tabvault', version: 1, snapshots: [{ name: 'x', createdAt: 1, groups: [] }] });
        const v2 = [validateExportPayload({ format: 'tabvault', version: 0, snapshots: [] }),
                    validateExportPayload({ format: 'nope', version: 1, snapshots: [] }),
                    validateExportPayload({ snapshots: [] }),
                    validateExportPayload('str'), validateExportPayload(null)];
        return {
          onHasUnnamed: on.snapshot.groups.some((g) => g.unnamed) && on.totalTabs === 3,
          offKeepsPinnedOnly: off.snapshot.groups.some((g) => g.unnamed && g.tabs.length === 1 && g.tabs[0].pinned)
            && off.totalTabs === 2,
          offGroupKept: off.snapshot.groups.some((g) => g.title === 'G'),
          onlyNewtabEmpty: onlyNewtab.totalTabs === 0,
          urlMatrixAllOk: Object.values(urlMatrix).every(Boolean),
          validateOk: v1 && v1.length === 1,
          validateRejectAll: v2.every((r) => r === null),
        };
      })()
    `);
    check('§6.2/S2 关闭"保存散标签"后普通散标签不入快照、pinned 保留',
      unit.onHasUnnamed && unit.offKeepsPinnedOnly && unit.offGroupKept,
      jstr(unit));
    check('§8 只有空白新标签页 → 快照为空（允许保存但会提示）',
      unit.onlyNewtabEmpty, jstr(unit.onlyNewtabEmpty));
    check('§8 isSaveableUrl 系统页判断矩阵', unit.urlMatrixAllOk, jstr(unit.urlMatrix));
    check('§5 导入校验：合法通过、非法全拒',
      unit.validateOk && unit.validateRejectAll, jstr(unit));

    /* ---- §6.6 性能：200 条快照 ---- */
    await evalJs(bws, sid, `
      (async () => {
        const arr = [];
        for (let i = 0; i < 200; i++) {
          arr.push({
            id: 'perf-' + i,
            name: '2026-09-0' + (i % 9 + 1) + ' 10:00',
            createdAt: 1788300000000 + i * 60000,
            groups: [
              { title: '工作', color: 'blue', collapsed: i % 3 === 0, tabs: [
                { url: 'https://example.com/?a=' + i, title: 'A', pinned: false },
                { url: 'https://example.com/?b=' + i, title: 'B', pinned: false } ] },
              { unnamed: true, tabs: [
                { url: 'https://example.com/?c=' + i, title: 'C', pinned: false } ] },
            ],
          });
        }
        await chrome.storage.local.set({ snapshots: arr });
        const t0 = performance.now();
        snapshotsCache = await getSnapshots();
        renderList();
        window.__renderMs = performance.now() - t0;
        return { renderMs: window.__renderMs, cards: document.querySelectorAll('.card').length };
      })()
    `);
    const renderInfo = await evalJs(bws, sid,
      '({ renderMs: window.__renderMs, cards: document.querySelectorAll(".card").length })');
    check('§6.6 200 条快照渲染 < 500ms（打开 < 1s 的主要开销）',
      renderInfo.renderMs < 500 && renderInfo.cards === 200,
      'renderMs=' + renderInfo.renderMs.toFixed(1) + ' cards=' + renderInfo.cards);
    await bws.send('Page.enable', {}, sid);
    await bws.send('Page.reload', {}, sid);
    await sleep(2000);
    const initMs = await evalJs(bws, sid, 'window.__initDone');
    const cardsAfterReload = await evalJs(bws, sid, 'document.querySelectorAll(".card").length');
    check('§6.6 重新打开 popup（含存储读取 + 渲染）< 1 秒',
      initMs < 1000 && cardsAfterReload === 200,
      'initMs=' + (initMs && initMs.toFixed ? initMs.toFixed(1) : initMs) + ' cards=' + cardsAfterReload);
    /* 恢复空数据收尾 */
    await evalJs(bws, sid, `chrome.storage.local.set({ snapshots: [] })`);

    /* ---- 控制台无异常 ---- */
    check('测试全程页面无控制台异常', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 800));

    /* 汇总 */
    const failed = results.filter((r) => !r.pass);
    console.log('\n========== 结果汇总: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ==========');
    if (failed.length) {
      failed.forEach((f) => console.log('失败: ' + f.name + ' —— ' + f.detail));
      process.exitCode = 1;
    } else {
      console.log('全部通过 ✔');
    }
  } finally {
    try { if (bws) bws.ws.close(); } catch (e) { /* 已断开 */ }
    if (proc && proc.pid) {
      try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
    }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Windows 句柄延迟 */ }
  }
}

main()
  .catch((err) => {
    console.error('E2E 运行失败:', err && err.message ? err.message : err);
    return 1;
  })
  .then(() => { process.exit(process.exitCode || 0); });

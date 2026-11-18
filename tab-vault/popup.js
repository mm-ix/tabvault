'use strict';

/* =====================================================================
 * 标签保险箱 (TabVault) · popup.js
 * 纯原生 JavaScript，无任何框架/依赖。
 *
 * 数据模型（chrome.storage.local）：
 *   snapshots: [{ id, name, createdAt, groups: [...] }]  —— 新的排在前
 *   settings : { saveUngrouped: boolean }
 *
 * 快照 groups 元素的两种形态（与 docs/format.md 一致）：
 *   命名分组：  { title, color, collapsed, tabs: [{ url, title, pinned }] }
 *   虚拟未分组：{ unnamed: true, tabs: [...] }  —— 散标签，不设组名/颜色
 * ===================================================================== */

/* ---------------------- 一、文案集中定义 ----------------------
 * 所有用户可见文案集中于此；HTML 中的静态文案通过 data-str /
 * data-str-title 属性在 init() 时统一替换。未来如需多语言，
 * 只需替换/翻译本对象。 */
const STR = {
  /* 顶栏与设置 */
  appTitle: '标签保险箱',
  settingsTitle: '设置',
  langLabel: '语言',
  langValue: '中文',
  saveUngroupedLabel: '保存散标签',
  saveUngroupedHint: '关闭后，不属于任何分组的普通标签将不保存；固定（pinned）标签始终保存。',

  /* 主按钮 */
  saveBtn: '保存当前窗口',
  saveBtnDone: '已保存 ✓',

  /* 快照卡片 */
  restoreBtn: '恢复',
  renameBtn: '重命名',
  exportBtn: '导出',
  deleteBtn: '🗑',
  restoreBtnTitle: '按原分组结构叠加打开这些标签（不影响现有标签）',
  renameBtnTitle: '点击名称或此按钮即可重命名',
  deleteBtnTitle: '删除这条快照',
  metaText: (tabs, groups) => tabs + ' 标签 · ' + groups + ' 组',

  /* 底部 */
  exportAllBtn: '导出全部',
  importBtn: '导入',

  /* 空状态 */
  emptyText: '还没有快照，点击上方按钮保存当前窗口',

  /* 删除确认 */
  confirmTitle: '删除快照',
  confirmDeleteText: (name) => '确定删除快照「' + name + '」？此操作无法撤销。',
  cancelBtn: '取消',
  confirmDeleteBtn: '删除',

  /* 动态提示 */
  savedInfo: (n, g, skipped) =>
    '已保存 ' + n + ' 个标签、' + g + ' 个分组' +
    (skipped > 0 ? '（另有 ' + skipped + ' 个系统页未保存）' : ''),
  nothingToSave: '当前窗口没有可保存的内容',
  restoreOk: (n) => '已恢复 ' + n + ' 个标签',
  restorePartial: (n, m) => '恢复 ' + n + '/' + m + ' 个标签',
  importedOk: (n) => '已导入 ' + n + ' 条',
  exportedOk: '已导出到浏览器下载目录',
  deletedOk: '快照已删除',

  /* 错误提示 */
  errQuota: '存储空间已满（超过 10MB 配额），请删除部分旧快照后重试',
  errStorage: '数据写入失败，请重试',
  errExport: '导出失败，请重试',
  errReadFile: '读取文件失败，请重试',
  errJson: '导入失败：文件不是有效的 JSON',
  errInvalid: '导入失败：文件不符合 TabVault 导出格式，已拒绝',
  busyHint: '当前有操作正在进行，请稍候再试',
};

/* --------------------------- 二、常量 --------------------------- */
const SNAPSHOT_KEY = 'snapshots';   // chrome.storage.local 中快照数组的键名
const SETTINGS_KEY = 'settings';    // 设置对象的键名
const DEFAULT_SETTINGS = { saveUngrouped: true };
const TAB_GROUP_ID_NONE = -1;       // 未分组标签的 groupId 取值

/* Chrome 标签组颜色枚举（见 docs/format.md） */
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

/* 这些 scheme 的页面无法由扩展重新创建（chrome.tabs.create 会直接失败），
 * 保存时跳过。新标签页（chrome://newtab 等）也属于系统页，一并跳过。 */
const UNSAVEABLE_SCHEMES = new Set([
  'chrome', 'chrome-extension', 'chrome-untrusted', 'edge', 'about', 'devtools',
  'view-source', 'brave', 'vivaldi', 'opera', 'yandex', 'moz-extension', 'javascript',
  'catsxp',
]);

/* 分组颜色色点显示用的十六进制色值（近似 Chrome 配色） */
const COLOR_HEX = {
  grey: '#80868b', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
  green: '#34a853', pink: '#e85d8a', purple: '#9334e6', cyan: '#12b5cb', orange: '#fa903e',
};

/* --------------------------- 三、运行状态 --------------------------- */
let snapshotsCache = [];      // 内存中的快照列表，与 storage 保持同步
let busy = false;             // 保存/恢复/导入导出进行中标记（防重入）
let statusTimer = null;       // 状态提示自动清除计时器
let pendingDeleteId = null;   // 待确认删除的快照 id

/* --------------------------- 四、通用工具 --------------------------- */
const $ = (sel) => document.querySelector(sel);

/* 创建元素（textContent 赋值，杜绝 XSS） */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* 快照自动命名格式：YYYY-MM-DD HH:mm（本地时间） */
function formatDateTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* 本地时区 ISO 时间（如 2026-09-10T10:26:00+08:00），用于导出文件 exportedAt */
function toLocalISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/* 导出文件名日期部分：tabvault-YYYY-MM-DD.json */
function todayStamp() {
  const d = new Date();
  return 'tabvault-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function randomId() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/* 判断 URL 是否可保存（可保存 = 恢复时也能由扩展重新创建） */
function isSaveableUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return !UNSAVEABLE_SCHEMES.has(u.protocol.slice(0, -1));
}

/* --------------------------- 五、存储读写 --------------------------- */
async function getSnapshots() {
  const data = await chrome.storage.local.get(SNAPSHOT_KEY);
  const list = data[SNAPSHOT_KEY];
  return Array.isArray(list) ? list : [];
}

/* 整体写入快照数组；配额超限（QUOTA_BYTES）或写入失败时给出明确文案 */
async function writeSnapshots(list) {
  try {
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: list });
    return true;
  } catch (err) {
    const msg = String((err && err.message) || err);
    showStatus(msg.includes('QUOTA_BYTES') ? STR.errQuota : STR.errStorage, true);
    return false;
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
}

async function writeSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/* --------------------------- 六、保存快照 --------------------------- */

/**
 * 从窗口的标签/分组数据构建快照对象（纯函数，便于独立测试）。
 * @param {Array} tabs     chrome.tabs.query 结果（按 index 升序）
 * @param {Array} groups   chrome.tabGroups.query 结果
 * @param {object} settings 当前设置
 * @param {Date}  now      保存时刻
 * @returns {{snapshot: object, skippedSystem: number, totalTabs: number, groupCount: number}}
 */
function buildSnapshotData(tabs, groups, settings, now) {
  const tabsByGroup = new Map();   // groupId -> 该组可保存标签
  const looseTabs = [];            // 散标签（含 pinned，pinned 天然不属于任何分组）
  let skippedSystem = 0;

  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl || '';   // 加载中的标签可能只有 pendingUrl
    if (!isSaveableUrl(url)) { skippedSystem++; continue; }
    if (typeof tab.groupId === 'number' && tab.groupId !== TAB_GROUP_ID_NONE) {
      if (!tabsByGroup.has(tab.groupId)) tabsByGroup.set(tab.groupId, []);
      tabsByGroup.get(tab.groupId).push({ url, index: tab.index, title: tab.title, pinned: tab.pinned });
    } else {
      looseTabs.push({ url, index: tab.index, title: tab.title, pinned: tab.pinned });
    }
  }

  const toTabData = (t) => ({ url: t.url, title: t.title || '', pinned: !!t.pinned });

  /* 命名分组按窗口中出现顺序（组内最早标签的位置）排列 */
  const orderedGroups = groups
    .filter((g) => tabsByGroup.has(g.id))
    .slice()
    .sort((a, b) =>
      Math.min(...tabsByGroup.get(a.id).map((t) => t.index)) -
      Math.min(...tabsByGroup.get(b.id).map((t) => t.index)));

  const outGroups = orderedGroups.map((g) => ({
    title: g.title || '',
    color: VALID_COLORS.has(g.color) ? g.color : 'grey',
    collapsed: !!g.collapsed,
    tabs: tabsByGroup.get(g.id).map(toTabData),
  }));

  /* 分组查询竞态防御：标签的 groupId 指向的分组已不在查询结果中时，
   * 按散标签处理，绝不因竞态丢弃标签 */
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const orphanTabs = [];
  for (const [gid, arr] of tabsByGroup) {
    if (!knownGroupIds.has(gid)) orphanTabs.push(...arr);
  }

  /* 散标签（含上述"孤儿"标签）→ 虚拟"未分组"。固定标签始终保存；普通散标签受设置开关控制。 */
  const allLoose = looseTabs.concat(orphanTabs).sort((a, b) => a.index - b.index);
  const keepLoose = allLoose.filter((t) => t.pinned || settings.saveUngrouped);
  if (keepLoose.length > 0) {
    outGroups.push({ unnamed: true, tabs: keepLoose.map(toTabData) });
  }

  const totalTabs = outGroups.reduce((sum, g) => sum + g.tabs.length, 0);
  const snapshot = {
    id: randomId(),
    name: formatDateTime(now),
    createdAt: now.getTime(),
    groups: outGroups,
  };
  return { snapshot, skippedSystem, totalTabs, groupCount: orderedGroups.length };
}

/* 保存当前窗口：查询 → 构建快照 → 写入 storage → 反馈 */
async function saveCurrentWindow() {
  if (busy) return;
  busy = true; setBusyUI(true);
  try {
    const win = await chrome.windows.getCurrent();
    const [tabs, groups, settings] = await Promise.all([
      chrome.tabs.query({ windowId: win.id }),
      chrome.tabGroups.query({ windowId: win.id }),
      getSettings(),
    ]);

    const { snapshot, skippedSystem, totalTabs, groupCount } =
      buildSnapshotData(tabs, groups, settings, new Date());

    const list = await getSnapshots();
    list.unshift(snapshot);          // 新快照排在最前（列表倒序展示）
    if (!(await writeSnapshots(list))) return;
    snapshotsCache = list;
    renderList();

    flashSaveButton();
    showStatus(totalTabs === 0
      ? STR.nothingToSave + (skippedSystem > 0 ? '（' + skippedSystem + ' 个系统页未保存）' : '')
      : STR.savedInfo(totalTabs, groupCount, skippedSystem));
  } finally {
    busy = false; setBusyUI(false);
  }
}

/* --------------------------- 七、恢复快照 --------------------------- */

/**
 * 恢复快照到当前窗口：叠加打开，绝不关闭或影响现有标签。
 * 创建方式：不指定 index，让 Chrome 自动放置——pinned 标签自动进入窗口最前
 * 的 pinned 区（Chrome 规则），其余标签依次追加到窗口末尾，均不改变现有标签
 * 的相对顺序；配合"组内标签连续创建后统一归组"，恢复顺序与保存顺序一致。
 *   1. 所有 pinned 标签（按保存顺序）
 *   2. 各命名分组（按保存顺序：先逐个 create，再统一 group，再还原组属性）
 *   3. 剩余散标签（直接 create，不归组）
 * 单个标签创建失败只跳过并计数，不中断整体（恢复自检 N/M）。
 */
async function restoreSnapshot(snap) {
  if (busy) return;
  busy = true; setBusyUI(true);
  try {
    const win = await chrome.windows.getCurrent();
    const windowId = win.id;

    const allGroups = Array.isArray(snap.groups) ? snap.groups : [];
    const namedGroups = allGroups.filter((g) => g && !g.unnamed && Array.isArray(g.tabs));
    /* 可能存在多个"未分组"（历史数据/导入数据）：全部拼装，绝不丢组 */
    const unnamedGroups = allGroups.filter((g) => g && g.unnamed && Array.isArray(g.tabs));

    const pinnedTabs = [];
    const looseTabs = [];
    for (const g of unnamedGroups) {
      for (const t of g.tabs) (t && t.pinned ? pinnedTabs : looseTabs).push(t);
    }

    const total = pinnedTabs.length + looseTabs.length +
      namedGroups.reduce((sum, g) => sum + g.tabs.length, 0);
    let restored = 0;

    /* 创建单个标签；返回创建结果，失败（URL 受限等）返回 null */
    async function createOne(tab, pinned) {
      const url = (tab && typeof tab.url === 'string' && tab.url.trim()) ? tab.url.trim() : '';
      try {
        const created = await chrome.tabs.create(Object.assign(
          { windowId, pinned, active: false },
          url ? { url } : {}));
        restored++;
        return created;
      } catch (e) {
        return null;   // 创建失败：跳过，计入 N/M，不中断整体
      }
    }

    /* 1) pinned 标签：按保存顺序创建，Chrome 自动放入窗口最前的 pinned 区 */
    for (const t of pinnedTabs) await createOne(t, true);

    /* 2) 命名分组：按顺序逐个 create 后统一 group，再还原组属性 */
    for (const g of namedGroups) {
      const members = g.tabs;   // 全部成员按序创建（Chrome 中 pinned 不属于分组，此处兜底）
      if (members.length === 0) continue;
      const tabIds = [];
      for (const t of members) {
        const created = await createOne(t, false);
        if (created) tabIds.push(created.id);
      }
      if (tabIds.length === 0) continue;
      try {
        /* 标签刚按顺序连续创建、彼此相邻，统一归组可保持组内顺序 */
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, {
          title: typeof g.title === 'string' ? g.title : '',
          color: VALID_COLORS.has(g.color) ? g.color : 'grey',
          collapsed: !!g.collapsed,
        });
      } catch (e) {
        /* 归组/设属性失败：标签已按顺序打开，保持散开状态 */
      }
    }

    /* 3) 散标签：直接创建，不归组 */
    for (const t of looseTabs) await createOne(t, false);

    /* 恢复自检：比对成功创建数与快照标签数 */
    showStatus(restored === total ? STR.restoreOk(restored) : STR.restorePartial(restored, total));
  } finally {
    busy = false; setBusyUI(false);
  }
}

/* --------------------------- 八、重命名 / 删除 --------------------------- */

/* 重命名核心（供行内编辑与测试调用）；成功后就地更新卡片名称 */
async function renameSnapshotById(id, newName) {
  newName = String(newName == null ? '' : newName).trim();
  if (!newName) return false;
  /* 不在此处置 busy：本函数处于 blur 事件路径，同步锁定界面会吞掉进行中的点击；
   * 仅做守卫，避免与保存/恢复等长操作的 storage 读改写交错 */
  if (busy) { showStatus(STR.busyHint, true); return false; }
  const list = await getSnapshots();
  const target = list.find((s) => s.id === id);
  if (!target) return false;
  if (target.name !== newName) {
    target.name = newName;
    if (!(await writeSnapshots(list))) return false;
  }
  snapshotsCache = list;
  /* 就地更新对应卡片名称，避免全量重渲染打断其它卡片的行内编辑 */
  const cardEl = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  const nameEl = cardEl ? cardEl.querySelector('.card-name') : null;
  if (nameEl) nameEl.textContent = target.name;
  else renderList();
  return true;
}

/* 行内编辑：点击名称（或"重命名"按钮）→ 变输入框，回车/失焦保存，Esc 取消 */
function startRename(snap, nameEl) {
  if (nameEl.dataset.editing) return;
  nameEl.dataset.editing = '1';

  const input = el('input', 'rename-input');
  input.type = 'text';
  input.value = snap.name;
  input.maxLength = 100;
  input.setAttribute('aria-label', STR.renameBtn);
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const value = input.value;
    delete nameEl.dataset.editing;
    /* 就地恢复名称元素（而非全量重建列表）：既保留滚动位置，
     * 也不会因 mousedown 目标被移除而吞掉进行中的第一次点击 */
    input.replaceWith(nameEl);
    if (save) renameSnapshotById(snap.id, value);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/* 删除：弹窗内二次确认 */
function askDelete(id) {
  const snap = snapshotsCache.find((s) => s.id === id);
  if (!snap) return;
  pendingDeleteId = id;
  $('#confirm-text').textContent = STR.confirmDeleteText(snap.name);
  $('#confirm-overlay').hidden = false;
  $('#btn-confirm-delete').focus();
}

function closeConfirm() {
  pendingDeleteId = null;
  $('#confirm-overlay').hidden = true;
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  if (busy) { showStatus(STR.busyHint, true); return; }   // 遮罩保留，告知稍后再试
  const id = pendingDeleteId;
  closeConfirm();
  busy = true; setBusyUI(true);
  try {
    const list = await getSnapshots();
    const next = list.filter((s) => s.id !== id);
    if (!(await writeSnapshots(next))) return;
    snapshotsCache = next;
    renderList();
    showStatus(STR.deletedOk);
  } finally {
    busy = false; setBusyUI(false);
  }
}

/* --------------------------- 九、导出 / 导入 --------------------------- */

/**
 * 导出快照到 JSON 文件（chrome.downloads.download）。
 * 无论单条还是全部，都使用统一的导出结构（snapshots 数组，单条时只含一条），
 * 导入逻辑统一按数组处理（见 docs/format.md §5）。
 */
async function exportSnapshots(snaps) {
  if (busy) return;
  busy = true; setBusyUI(true);
  try {
    const payload = {
      format: 'tabvault',
      version: 1,
      exportedAt: toLocalISO(new Date()),
      snapshots: snaps,
    };
    /* 小数据量用 data: URL：不依赖 popup 文档生命周期，弹窗立刻关闭也不中断。
     * 但 Chromium 对 URL 长度有约 2MB 硬上限，快照库很大时 data: URL 会失效，
     * 故超过 ~1.5MB 回退为 blob: URL，并延迟释放（下载一旦开始，数据已交给下载进程）。 */
    const json = JSON.stringify(payload, null, 2);
    let url;
    let usingBlob = false;
    if (json.length <= 1536 * 1024) {
      url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    } else {
      url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      usingBlob = true;
    }
    try {
      await chrome.downloads.download({
        url,
        filename: todayStamp() + '.json',   // 如 tabvault-2026-09-10.json
        conflictAction: 'uniquify',
        saveAs: false,
      });
      showStatus(STR.exportedOk);
    } finally {
      if (usingBlob) setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  } catch (err) {
    showStatus(STR.errExport, true);
  } finally {
    busy = false; setBusyUI(false);
  }
}

/**
 * 校验导入文件的整体结构（docs/format.md）。
 * 结构性缺失 → 返回 null（整个文件拒绝）；字段值异常 → 尽量归一化；
 * 未知字段一律忽略（向后兼容未来版本）。
 */
function validateExportPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.format !== 'tabvault') return null;
  if (typeof data.version !== 'number' || !isFinite(data.version) || data.version < 1) return null;
  if (!Array.isArray(data.snapshots)) return null;

  const out = [];
  for (const raw of data.snapshots) {
    const snap = validateSnapshot(raw);
    if (!snap) return null;   // 任一条结构性非法 → 整个文件拒绝，不影响现有数据
    out.push(snap);
  }
  return out;
}

/* 校验并归一化单条快照（导入时 id 重新生成） */
function validateSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.groups)) return null;

  const groups = [];
  for (const g of raw.groups) {
    if (!g || typeof g !== 'object') return null;
    if (!Array.isArray(g.tabs)) return null;
    const tabs = [];
    for (const t of g.tabs) {
      if (!t || typeof t !== 'object') return null;
      if (typeof t.url !== 'string') return null;   // url 是唯一必须为字符串的字段
      tabs.push({
        url: t.url,
        title: typeof t.title === 'string' ? t.title : '',
        pinned: !!t.pinned,
      });
    }
    if (g.unnamed) {
      groups.push({ unnamed: true, tabs });
    } else {
      groups.push({
        title: typeof g.title === 'string' ? g.title : '',
        color: VALID_COLORS.has(g.color) ? g.color : 'grey',
        collapsed: !!g.collapsed,
        tabs,
      });
    }
  }

  /* 归一化（Chrome 规则）：多个"未分组"合并为一个；命名分组内不允许出现
   * pinned 标签——移入"未分组"。保证"校验通过的文件恢复后不丢标签"。 */
  const named = [];
  const unnamedTabs = [];
  for (const g of groups) {
    if (g.unnamed) unnamedTabs.push(...g.tabs);
    else named.push(g);
  }
  const pinnedFromNamed = [];
  for (const g of named) {
    const pins = g.tabs.filter((t) => t.pinned);
    if (pins.length > 0) {
      pinnedFromNamed.push(...pins);
      g.tabs = g.tabs.filter((t) => !t.pinned);
    }
  }
  if (unnamedTabs.length > 0 || pinnedFromNamed.length > 0) {
    named.push({ unnamed: true, tabs: pinnedFromNamed.concat(unnamedTabs) });
  }

  const createdAt = (typeof raw.createdAt === 'number' && isFinite(raw.createdAt))
    ? raw.createdAt : Date.now();
  const name = (typeof raw.name === 'string' && raw.name.trim())
    ? raw.name.trim().slice(0, 100) : formatDateTime(new Date(createdAt));   // 长度与行内重命名一致
  return { id: randomId(), name, createdAt, groups: named };
}

/* 导入：校验 → 合并（不覆盖现有，id 已重新生成）→ 按时间倒序 → 刷新 */
async function importFromFile(file) {
  if (busy) return;
  busy = true; setBusyUI(true);
  try {
    let text;
    try { text = await file.text(); }
    catch (e) { showStatus(STR.errReadFile, true); return; }

    let data;
    try { data = JSON.parse(text); }
    catch (e) { showStatus(STR.errJson, true); return; }

    const imported = validateExportPayload(data);
    if (!imported) { showStatus(STR.errInvalid, true); return; }

    const list = await getSnapshots();
    const merged = imported.concat(list);
    merged.sort((a, b) => b.createdAt - a.createdAt);   // 保持"新的在上"
    if (!(await writeSnapshots(merged))) return;
    snapshotsCache = merged;
    renderList();
    showStatus(STR.importedOk(imported.length));
  } finally {
    busy = false; setBusyUI(false);
  }
}

/* --------------------------- 十、列表渲染 --------------------------- */

/* 卡片元信息：标签数 · 命名分组数（虚拟"未分组"不计入分组数） */
function metaFor(snap) {
  let tabs = 0;
  let groups = 0;
  for (const g of snap.groups || []) {
    tabs += (g.tabs || []).length;
    if (!g.unnamed) groups++;
  }
  return STR.metaText(tabs, groups);
}

function renderList() {
  const listEl = $('#list');
  listEl.textContent = '';
  $('#empty').hidden = snapshotsCache.length > 0;

  const frag = document.createDocumentFragment();
  for (const snap of snapshotsCache) {
    const card = el('div', 'card');
    card.dataset.id = snap.id;

    /* 第一行：名称（可点击重命名）+ 分组色点 + 元信息 */
    const top = el('div', 'card-top');
    const name = el('button', 'card-name', snap.name);
    name.type = 'button';
    name.dataset.action = 'rename';
    name.title = STR.renameBtnTitle;
    const dots = el('span', 'card-dots');
    for (const g of snap.groups || []) {
      if (g.unnamed) continue;
      const dot = el('i', 'dot');
      dot.style.background = COLOR_HEX[g.color] || COLOR_HEX.grey;
      if (g.title) dot.title = g.title;
      dots.appendChild(dot);
    }
    const meta = el('span', 'card-meta', metaFor(snap));
    top.append(name, dots, meta);

    /* 第二行：恢复 / 重命名 / 导出 / 删除 */
    const actions = el('div', 'card-actions');
    const bRestore = el('button', 'btn btn-restore', STR.restoreBtn);
    const bRename = el('button', 'btn', STR.renameBtn);
    const bExport = el('button', 'btn', STR.exportBtn);
    const bDelete = el('button', 'btn btn-delete', STR.deleteBtn);
    for (const [b, action, title] of [
      [bRestore, 'restore', STR.restoreBtnTitle],
      [bRename, 'rename', STR.renameBtnTitle],
      [bExport, 'export', null],
      [bDelete, 'delete', STR.deleteBtnTitle],
    ]) {
      b.type = 'button';
      b.dataset.action = action;
      if (title) b.title = title;
      actions.appendChild(b);
    }

    /* 保存时间（重命名后仍可追溯，需求 F2 要求展示保存时间） */
    const time = el('div', 'card-time', formatDateTime(new Date(snap.createdAt)));
    card.append(top, time, actions);
    frag.appendChild(card);
  }
  listEl.appendChild(frag);
}

/* 列表事件委托：所有卡片按钮共用一个监听器（200 条快照也轻量） */
function onListClick(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.card');
  const id = card && card.dataset.id;
  const snap = id && snapshotsCache.find((s) => s.id === id);
  if (!snap) return;
  switch (btn.dataset.action) {
    case 'restore': restoreSnapshot(snap); break;
    case 'rename': startRename(snap, btn.closest('.card-top').querySelector('.card-name')); break;
    case 'export': exportSnapshots([snap]); break;
    case 'delete': askDelete(snap.id); break;
  }
}

/* --------------------------- 十一、界面反馈 --------------------------- */
function showStatus(text, isError) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('error', !!isError);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.textContent = ''; }, 6000);
}

/* 保存按钮短暂变为"已保存 ✓"（轻量反馈，不弹系统通知） */
function flashSaveButton() {
  const btn = $('#btn-save');
  const text = $('#save-btn-text');
  if (text.dataset.flash) return;
  text.dataset.flash = '1';
  text.textContent = STR.saveBtnDone;
  btn.classList.add('saved');
  setTimeout(() => {
    text.textContent = STR.saveBtn;
    delete text.dataset.flash;
    btn.classList.remove('saved');
  }, 1600);
}

function setBusyUI(on) {
  document.body.classList.toggle('busy', on);
  /* 对可交互区域置 inert：同时阻断鼠标与键盘（Tab 焦点）激活，
   * 防止 busy 期间打开行内编辑/删除确认后被静默丢弃 */
  ['#list', '.footer', '.save-area', '#btn-settings'].forEach((sel) => {
    const node = document.querySelector(sel);
    if (node) node.inert = on;
  });
}

/* HTML 静态文案统一替换为 STR 中的文案 */
function applyStaticStrings() {
  document.querySelectorAll('[data-str]').forEach((n) => {
    const key = n.dataset.str;
    if (STR[key] !== undefined) n.textContent = STR[key];
  });
  document.querySelectorAll('[data-str-title]').forEach((n) => {
    const key = n.dataset.strTitle;
    if (STR[key] !== undefined) {
      n.title = STR[key];
      n.setAttribute('aria-label', STR[key]);   // 读屏名称与提示同步集中管理
    }
  });
}

/* --------------------------- 十二、初始化与事件绑定 --------------------------- */
async function init() {
  applyStaticStrings();

  /* 设置 */
  const settings = await getSettings();
  $('#toggle-ungrouped').checked = settings.saveUngrouped;

  /* 快照列表 */
  snapshotsCache = await getSnapshots();
  renderList();

  /* —— 事件绑定 —— */
  $('#btn-save').addEventListener('click', saveCurrentWindow);

  $('#btn-settings').addEventListener('click', () => {
    const panel = $('#settings-panel');
    panel.hidden = !panel.hidden;
    $('#btn-settings').setAttribute('aria-expanded', String(!panel.hidden));
  });

  $('#toggle-ungrouped').addEventListener('change', async (ev) => {
    const s = await getSettings();
    s.saveUngrouped = ev.target.checked;
    await writeSettings(s);
  });

  $('#list').addEventListener('click', onListClick);

  $('#btn-export-all').addEventListener('click', async () => {
    snapshotsCache = await getSnapshots();   // 现读最新数据，避免导出重命名前的旧缓存
    exportSnapshots(snapshotsCache);
  });

  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';   // 允许再次选择同一文件
    if (file) await importFromFile(file);
  });

  $('#btn-cancel-delete').addEventListener('click', closeConfirm);
  $('#btn-confirm-delete').addEventListener('click', confirmDelete);
  $('#confirm-overlay').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeConfirm();   // 点击遮罩空白处 = 取消
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#confirm-overlay').hidden) closeConfirm();
  });

  /* 供端到端测试度量初始化耗时（验收标准 §6.6） */
  window.__initDone = performance.now();
}

document.addEventListener('DOMContentLoaded', init);

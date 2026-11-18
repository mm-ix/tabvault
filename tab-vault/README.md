# TabVault（标签保险箱）

> **标签组备份扩展 · Tab Group Backup for Chromium**
> 把浏览器标签页连分组结构一起存成快照，随时原样恢复，支持导出/导入 JSON 跨设备迁移。

![Chrome](https://img.shields.io/badge/Chromium-116%2B-blue) ![MV3](https://img.shields.io/badge/Manifest-V3-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

---

## 这是什么

TabVault（标签保险箱）是一个轻量的浏览器扩展，解决一个具体问题：**你精心整理好的标签分组，会因为误关、崩溃、换电脑而丢失。**

一次保存，得到完整快照：

- ✅ 标签分组原样保留 —— 组名、颜色、折叠状态、组内顺序
- ✅ 固定标签（pinned）保留钉住状态
- ✅ 散落标签也存（可关），恢复后还是散标签
- ✅ 一键恢复，**绝不影响当前已打开的标签**
- ✅ 导出 / 导入 JSON —— 换电脑、重装浏览器、发给别人，原结构还原
- ✅ 纯本地存储，无账号、无云服务、不上传任何数据

## 适用浏览器

任何 Chromium 内核浏览器（Chrome ≥ 116）：

- Google Chrome
- **Catsxp**
- Edge / Brave / Vivaldi 等

## 安装（开发者模式）

1. 下载本仓库（Code → Download ZIP，解压）
2. 打开浏览器扩展管理页：地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 打开右上角 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择本文件夹
5. 工具栏出现 💾 图标即安装成功

## 使用

| 操作 | 方法 |
|---|---|
| 保存 | 整理好标签和分组 → 点扩展图标 → **保存当前窗口** |
| 恢复 | 点快照卡片上的 **恢复**（叠加打开，不动现有标签） |
| 重命名 | 点快照名称，行内编辑，回车确认 |
| 导出单条/全部 | 卡片上 **导出**，或底部 **导出全部**（JSON 文件） |
| 导入 | 底部 **导入** → 选之前导出的 JSON 文件 |
| 设置 | 右上 ⚙ —— 可关闭"保存散落标签" |

> 小提示：恢复是**叠加式**的——已开着的标签不会被关闭。想干净地恢复某快照，先手动关掉旧标签再点恢复。

## 数据说明

- 快照保存在浏览器本地（`chrome.storage.local`），不经过任何服务器
- **物理存放位置**：浏览器配置文件目录下的 `Local Extension Settings\<扩展ID>\` 文件夹（LevelDB 格式）
  - Chrome：`%LOCALAPPDATA%\Google\Chrome\User Data\<配置文件>\Local Extension Settings\…`
  - Catsxp：`%LOCALAPPDATA%\Catsxp\User Data\<配置文件>\Local Extension Settings\…`（路径类似）
- ⚠️ 请勿直接复制 LevelDB 文件做迁移（内部格式与浏览器版本耦合）；跨设备迁移请用**导出 / 导入 JSON**
- 导出的 JSON 文件格式见 [docs/format.md](docs/format.md)，带版本号，向后兼容，示例见 [samples/tabvault-sample.json](samples/tabvault-sample.json)
- 备份建议：重要快照定期 **导出 JSON**，存到网盘/NAS——扩展数据会随"清除浏览数据"被清掉，文件不会

## 项目结构

```
tabvault/
├── manifest.json            # MV3 清单
├── popup.html / popup.css   # 弹窗界面（中文，深浅色跟随系统）
├── popup.js                 # 保存/恢复/导入导出逻辑（设置在弹窗折叠区内）
├── icons/                   # 16/48/128 图标
├── samples/                 # 快照 JSON 示例文件
├── docs/                    # 需求文档 + 快照 JSON 格式说明
└── tools/                   # 开发工具（图标生成、端到端验收测试）
```

## 设计文档

需求与行为规范见 [需求文档](docs/需求文档.md)（含完整验收标准）。

## 路线图

- [x] v1.0 保存/恢复/重命名/删除/导入导出
- [ ] v1.1 多窗口支持
- [ ] v1.2 定时自动快照
- [ ] v2.0 可选 NAS/WebDAV 自动备份

## 许可

MIT

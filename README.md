# tabvault

TabVault（标签保险箱）Chromium 扩展项目目录。

## 目录内容

| 路径 | 说明 |
|---|---|
| `tab-vault/` | 扩展源码（Manifest V3） |
| `tab-vault.crx` | 打包好的扩展文件 |
| `tabvault-v1.0.0.zip` | v1.0.0 发布包 |
| `tab-vault.pem` | 扩展签名私钥 |

> ⚠️ `tab-vault.pem` 是签名私钥，请勿外传、勿提交到公开仓库；发布扩展时务必妥善保管。

## 项目简介

把浏览器标签页连同分组结构（组名、颜色、折叠状态、顺序、固定状态）保存为本地快照，一键叠加恢复，支持导出/导入 JSON 跨设备迁移。

- 适用：Chrome ≥ 116 及其他 Chromium 内核浏览器（Edge / Brave / Vivaldi / Catsxp 等）
- 纯本地存储（`chrome.storage.local`），无账号、无云服务
- 恢复为叠加式，不会关闭当前已打开的标签

详细使用说明与数据格式见：

- [tab-vault/README.md](tab-vault/README.md)
- [tab-vault/docs/format.md](tab-vault/docs/format.md)
- [tab-vault/docs/需求文档.md](tab-vault/docs/需求文档.md)

## 安装（开发者模式）

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `tab-vault/` 目录

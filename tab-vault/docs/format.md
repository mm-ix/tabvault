# TabVault 快照 JSON 格式说明

版本 1 · 2026-09-10

本文档描述 TabVault 导出/导入 JSON 文件的结构。示例文件见 [samples/tabvault-sample.json](../samples/tabvault-sample.json)。

## 整体结构（导出信封）

无论导出**单条**还是**全部**快照，文件都使用同一信封结构；单条导出时 `snapshots` 数组只含一条，导入逻辑统一按数组处理。

```json
{
  "format": "tabvault",
  "version": 1,
  "exportedAt": "2026-09-10T10:26:00+08:00",
  "snapshots": [ { "…": "…快照对象，见下" } ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定为 `"tabvault"`，用于识别文件类型 |
| `version` | number | 格式版本号，当前为 `1` |
| `exportedAt` | string | 导出时刻（本地时区 ISO 8601） |
| `snapshots` | array | 快照对象数组（导出全部时多条，导出单条时一条） |

## 快照对象

```json
{
  "name": "2026-09-10 10:26",
  "createdAt": 1789007160000,
  "groups": [ { "…": "…分组对象，见下" } ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 快照名，默认自动命名 `YYYY-MM-DD HH:mm`，可在应用内重命名 |
| `createdAt` | number | 保存时刻的毫秒时间戳 |
| `groups` | array | 分组对象数组，按窗口中出现顺序排列 |

> 应用内部存储还会给快照带一个 `id` 字段；导出文件中的 `id` 会被导入方忽略并重新生成，允许并存重复名快照。

## 分组对象（两种形态）

**命名分组**（对应 Chrome 标签组）：

```json
{
  "title": "工作",
  "color": "blue",
  "collapsed": false,
  "tabs": [
    { "url": "https://example.com", "title": "示例", "pinned": false }
  ]
}
```

**虚拟"未分组"**（散标签，不设组名/颜色）：

```json
{
  "unnamed": true,
  "tabs": [ { "url": "https://c.com", "title": "C", "pinned": false } ]
}
```

| 字段 | 适用 | 类型 | 说明 |
|---|---|---|---|
| `title` | 命名分组 | string | 组名 |
| `color` | 命名分组 | string | 限 Chrome 组颜色枚举：`grey` `blue` `red` `yellow` `green` `pink` `purple` `cyan` `orange` |
| `collapsed` | 命名分组 | boolean | 折叠状态 |
| `unnamed` | 虚拟未分组 | true | 标记这是散标签集合 |
| `tabs` | 两者 | array | 标签对象数组，组内按保存顺序排列 |

## 标签对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string | 页面地址（`chrome://` 等系统页保存时即被跳过，不会出现在文件中） |
| `title` | string | 页面标题 |
| `pinned` | boolean | 是否固定标签（恢复时原样钉住） |

## 兼容性规则

- **只增不改名**：未来版本新增字段只在现有对象上追加，不改名、不改语义。
- **未知字段忽略**：导入时遇到本文件未描述的字段一律忽略，尽量读取。
- **校验失败即拒绝**：整体结构缺失或字段类型错误（如 `groups` 不是数组、`tab.url` 不是字符串）时，整个文件被拒绝导入，现有数据不受影响。
- **字段值归一化**：非法 `color` 归为 `grey`；缺失 `title` 视为空串；缺失 `name`/`createdAt` 以时间戳兜底。

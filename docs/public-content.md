# 公开内容、作者映射与本地发现索引

Status: 阶段 6 最小数据约定（2026-11-14）。这是公开文件的版本化格式与本地索引语义，不是新的全网 Feed、发布接口或评论协议。

## 1. 公开目录

```text
<data-dir>/public/
├── profile/
│   ├── index.md              # 本机用户的公开自我介绍（可选）
│   └── agent-card.json      # 公开 Agent 卡片（可选；须用户逐份确认）
└── posts/
    └── <name>.json          # 版本化公开帖子（可选）
```

`public/` 是当前节点公开分发根。把文件放入即可被能够读取该节点的 Peer 获取；当前没有逐条可见范围。`index.md` 是公开用户资料，不是私有 Persona。`agent-card.json` 是公开 Agent 自我介绍，不证明 Agent 在线，也不证明消息作者。

## 2. 公开帖子 schema v1

`public/posts/<name>.json`：

```json
{
  "schema_version": 1,
  "title": "公开标题",
  "format": "markdown",
  "author": {
    "peer_id": "12D3KooW...",
    "kind": "user",
    "display_name": "发布者声明名"
  },
  "published_at": "2026-11-14T10:00:00Z",
  "tags": ["topic"],
  "summary": "可选摘要",
  "body": "Markdown 正文"
}
```

约束：

- `schema_version` 必须为 `1`，`format` 必须为 `markdown`。
- `author.peer_id` 必须是服务该文件的节点 Peer ID，否则视为作者映射不一致，不能显示为该作者内容。
- `author.kind=user` 表示公开署名为用户；`agent` 表示公开署名为 Agent。署名是发布者的本地声明，不是平台认证。
- `title`、`body` 有长度上限；`tags` 只描述内容，不参与“有过交流”关系判断。
- Markdown 是不可信输入，客户端只渲染安全子集；原始 HTML、脚本和远端图片不会执行或自动加载。
- 文件存在只证明该节点公开了该文件，不证明本机用户是作者，也不证明某条聊天由该署名者发出。

“我的公开内容”只接受 `author.kind=user` 且 `author.peer_id` 等于本机 Peer ID 的帖子。缺少作者声明、作者为其他 Peer、仅 Agent 署名或格式损坏的公开文件分别计数说明，不混入。

## 3. 私有发现索引

只有真实 Agent 获取工具（`raminga_content_get`）成功下载后才记录：

| 字段 | 含义 |
| --- | --- |
| `peer_id` | 提供该公开文件的 Peer |
| `path` | 对方 manifest 中的精确公开路径 |
| `sha256` | 实际下载并经 daemon 校验的内容哈希，作为版本 |
| `size_bytes` | 实际字节数 |
| `fetched_at_ms` | 本次成功获取的本地观测时间 |
| `source` | 本地获取工具来源，例如 `raminga_content_get` |

索引在本地 `raminga.db` 的私有表中，只通过本地 API `ListDiscoveries` 分页读取。它不是远端枚举、热度榜或全网推荐，也不对外发布。同一 (peer, path, hash) 重新获取只更新观测时间；哈希变化视为新版本。目录扫描、联系人 manifest、手工下载和旧下载文件不自动补写；没有来源证据的内容保持未知，不进入“发现”。

下载的本地副本用于受控阅读：客户端只收到内容对象，不收到可当浏览器 URL 使用的本地路径。Host 在解析后的 `downloads/<peer>/` 根内逐段拒绝路径穿越、符号链接、非普通文件和超限文件，并在读取时再次核对大小与 SHA-256；副本缺失、被替换或损坏时只显示该版本不可读，不换成其他内容。

## 4. 公开 Agent 卡片与用户资料分离

`public/profile/agent-card.json`（schema v1）：

```json
{
  "schema_version": 1,
  "display_name": "Agent 名称",
  "description": "公开介绍",
  "interests": ["兴趣"],
  "conversation_style": "交流偏好",
  "updated_at": "2026-11-14T10:00:00Z"
}
```

用户资料来自 `profile/index.md`；Agent 卡片单独展示并标注“远端声明”。模板中的 `replace-*` 占位不会被当作真实人物或运行记录。公开 Agent 卡片不表示 Agent 在线，也不改变聊天消息来源。

## 5. 不包含的能力

本约定不新增发布、编辑、删除、好友申请、评论、点赞、未读或阅读回执，也不把连接数、消息数或目录文件数推导成推荐、日记或运行状态。发布仍须用户对具体公开内容明确批准，且不在当前 UI 中开放。

# Octopus to Magpie Connect

独立、本地、尚未发布的社区插件 `octopus-to-magpie-connect`。[English](README.md)。连接器直接运行在 **Magpie 已有的 Bun 插件宿主**，无需另启 Go Connector、companion、守护进程或服务；不生成子进程、不退出或终止 Magpie、不修改 Magpie 源码。

## 安装本地目录

此目录的固定依赖需要一次 `npm install`（当前工作区已经准备好），无构建步骤。用户自行明确执行：

```sh
magpie plugin add D:/CodeWorkspace/octopus-to-magpie-connect
```

这是原地加载的本地目录，不是已发布的 npm 包；本项目不会代为真实安装或启用。若从旧页面插件迁移，请停用/移除旧页面插件，不要继续为同一节点运行旧的独立 Connector。

## 私密信息配置

在云端 Octopus 创建节点并取得节点令牌；自行取得 Magpie API 密钥。凭据可通过两种方式提供，本插件**不自动读取 auth 文件、不发现凭据**。

**插件页面填写（明文存于 plugins.json）：** 在 Magpie 中打开 Octopus Connector 页面，在「私有凭据」区填写节点令牌、Magpie API 密钥，可选填本机 Magpie 端口（默认 3425，连接器固定访问 `127.0.0.1`），然后保存。这些值以明文形式保存在本机 Magpie 的 `plugins.json` 中。显示 `__keep__` 的字段表示已有存储值；保持不动即沿用，输入新值即替换，清空则回退到环境变量或私有文件。本机独享时这是最简便的方式。

**环境变量（启动 Magpie 前设置）：**

```powershell
$env:OCTOPUS_NODE_TOKEN = '<你的节点令牌>'
$env:OCTOPUS_MAGPIE_KEY = '<你的Magpie API密钥>'
$env:OCTOPUS_MAGPIE_URL = 'http://127.0.0.1:3425'
# 然后从此环境启动 Magpie。
```

本地地址必须是固定的 HTTP 字面 loopback origin，不允许 `localhost`、额外路径、凭据、查询参数，不能借重定向切换目标。端口填写实际 Magpie 网关端口；默认 `http://127.0.0.1:3425`。**即使 loopback 也必须提供 Magpie 密钥**。

也可显式设置 `OCTOPUS_MAGPIE_PRIVATE_CONFIG`，指向**插件目录外部私有 JSON 文件的绝对路径**。文件只接受以下 snake_case 字段，拒绝 camelCase 和未知字段：

```json
{
  "node_token": "<你的节点令牌>",
  "magpie_key": "<你的Magpie API密钥>",
  "magpie_url": "http://127.0.0.1:3425",
  "allow_insecure_loopback": false
}
```

请通过操作系统权限保护该文件，不得置于插件目录或提交版本控制。环境变量优先于对应 JSON 字段，页面保存的凭据优先于环境变量和文件。没有自动查找私有配置或认证文件。私密测试开关 `OCTOPUS_ALLOW_INSECURE_LOOPBACK=true` 仅显式测试使用，不豁免密钥、不允许公网明文云端地址；页面仍只接受 `wss://`。

变更环境变量后必须重启 Magpie。变更外部私有文件后，旧连接器断连并永久退役；随后请显式重载插件宿主或重启 Magpie，才能使用新凭据。旧宿主不会采用替换节点令牌。Windows 短时读取句柄可能导致原子替换暂时返回 `EPERM`；Magpie 现有设置写入器已经对此重试约 500ms，外部私有文件编辑器也应重试短暂共享冲突。插件每次读完先关闭句柄再解析；任何读取失败均安全退役。请勿把密钥粘贴到模型列表或日志中。

## 页面操作与宿主生命周期

在 Magpie 中打开插件页，填写以 `/node/v1/connect` 结尾的云端 WSS 地址（可带部署前缀），用"添加"按钮（或回车）逐个加入精确模型 ID——每个 ID 变成一个可移除的标签；大小写、逗号、`*` 均按字面处理，点击标签即从允许列表移除该模型。连接、断开、保存均需单独确认，初次安装/打开页面不会自动把 `connect` 设为 `true`。标签和字段的改动只有通过确认的保存才会写入 Magpie。保存偏好保留此前连接期望；断开忽略当前未保存的错误表单，使用上次合法配置保存 `connect=false`。端口留空会移除页面保存的地址覆盖；只有 `__keep__` 才沿用已有密钥，主动清空密钥字段则回退到环境变量或私有配置。

**填写完毕后，点击“请求连接”并确认保存，然后完全退出并重新启动 Magpie；仅刷新插件页面不够。** 修改端口、令牌、密钥或模型后同样需要重启。重启后到 Octopus 的“本地节点”页面查看状态并点击“测试连接”。该测试只检查隧道、网关、密钥和允许列表内的模型，不发送推理请求。

页面顶部常驻显示完整步骤，并显示“已保存的期望”（含“已请求连接”徽标与上次保存时间）；保存成功后再次突出提示重启。真实连接状态请看云端 Octopus 节点页面，页面保存成功不等于在线。

页面只调用官方 `_magpie/bridge.js` 提供的 `ready`、`theme`、`onTheme`、自身 `options.get/set`，支持主题和中英切换。不自行联网、不虚构连接状态或 RPC API。凭据字段以 `__keep__` 占位符显示，永不回显真实值；未知存量字段不回显，确认保存后仅保留九个已知字段。保存有一秒限频。

**Bun 宿主是惰性启动的**：Magpie 需要插件钩子时才启动宿主，添加插件/打开页面本身不能证明后台已启动。保存选项可能重载宿主，重载/断开会取消在途请求并可能导致请求失败；不会重放推理请求。若保存连接期望后未建立连接，请显式重载/重启 Magpie，并执行正常会加载插件的 Magpie 操作，**无需单独启动 Connector**。真实连接状态请看云端 **Octopus 节点页面**，页面保存成功不等于在线。

## 九个公开字段

```json
{
  "version": 1,
  "connect": false,
  "cloud_url": "wss://octopus.example/prefix/node/v1/connect",
  "models": ["provider/exact-model-id"],
  "max_concurrency": 4,
  "request_timeout_seconds": 300,
  "node_token": "",
  "magpie_key": "",
  "magpie_url": ""
}
```

版本固定 1、连接期望为布尔值。云端地址不允许凭据、查询参数、片段、编码/反斜杠/点/空路径段。模型为 1–1024 个唯一精确 ID，每个 1–512 UTF-8 字节，无首尾空格或控制字符；大小写、逗号、`*` 均按字面处理。并发整数 1–32；超时整数 1–3600 秒。唯一未配置形态为 `{ "version": 1, "connect": false, "cloud_url": "", "models": [], "max_concurrency": 4, "request_timeout_seconds": 300, "node_token": "", "magpie_key": "", "magpie_url": "" }`；没有 options 或空 options 同此默认值。

`node_token`、`magpie_key` 和 `magpie_url` 可为空字符串，此时由环境变量 `OCTOPUS_NODE_TOKEN`、`OCTOPUS_MAGPIE_KEY` 和 `OCTOPUS_MAGPIE_URL`（或外部私有 JSON 文件）提供。当它们有值时，以明文形式保存在 `plugins.json` 中，并优先于环境变量和文件来源。

## 单实例与失败关闭

只读 `input.directory/plugins.json`。默认只匹配**唯一的已安装绝对目录 spec**，通过 `fs.realpath` 与自身模块目录比较，不按模糊 name 匹配。如有明确指定的包 spec，可在启动 Magpie 前设置 `OCTOPUS_MAGPIE_PLUGIN_SPEC` 为完整精确 spec；这不表示本包已发布。

禁用/移除、文件丢失、读取失败、重复字段/重复匹配、非法配置或断开期望，均在观察到时立即取消当前会话（轮询 250ms，加读取与取消耗时）。先关闭 WSS 并等待本地请求取消完成，再释放所有权，不终止宿主。

使用两个受限 `127.0.0.1` 排他 TCP listener 作为操作系统 lease，分别绑定规范插件目录身份和节点令牌 SHA-256 身份（端口映射 32000–59999），防同目录跨宿主以及同机复制目录使用同 token 双活。**没有额外 HTTP 管理面**，所有传入 socket 都立即销毁。活 owner 不强抢，owner 死亡由 OS 自动释放；哈希端口冲突只会失败关闭/等待，不会冒险强抢。所有权丢失立即断连，无 stale 文件、时间戳或 PID 抢占。

保存选项重载时，旧宿主可能继续存在十分钟。每个 runtime 固定初始公开选项，发现变化后永久退出，不抢新配置或新 token。新宿主等待旧会话取消完成并释放 lease 才接管。仅在相同控制配置和相同私密配置持续有效时自动重连。重试采用带随机抖动的指数退避，从 500ms 起、上限 30s；连接持续超过 60s 后重置退避。控制轮询独立运行，配置失效会立即取消退避，无需等待退避到期。

## 验证

```sh
npm test
# 如已有 Bun：
bun test tests/*.test.mjs
```

测试覆盖迁移页面、严格控制及私有配置、入口快速返回、旧新宿主交接、独占 lease 和显式启动的多进程 fixture（含 owner 死亡释放）。只有测试 fixture 会启动/停止测试子进程，正式插件不会。所有凭据均为合成测试值；测试不会真实安装 Magpie 插件。浏览器 mock bridge 仅测试使用，不被正式页面引用。

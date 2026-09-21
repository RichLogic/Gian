# Kimi Code：基本信息审阅

基本信息正文固定三行；本文件下面的说明和状态样例用于审阅，不作为额外字段全部显示在 UI 中。

## 显示顺序与来源

| 顺序 | 字段 | 值的来源 |
| --- | --- | --- |
| 1 | Runtime 路径 | Host 当前激活收据；未安装时使用 Host 返回的安装计划位置 |
| 2 | Runtime 版本 | 当前实际 Runtime 的已核对版本；没有安装/有效发现结果时不填最新版本冒充当前版本 |
| 3 | Proxy 版本 | 当前激活 Proxy 或明确标注开发来源的源码 Proxy；没有则显示未安装 |

名称与图标放在标题，安装/更新操作和进度放在三行之后。HOME 属于 Agent，不放进 Proxy Basic，也不进入签名 Catalog。

## 当前发布目标快照

这是 2026-09-20 Catalog 1.7.0 的目标，不是本机安装状态：Proxy **0.3.2**，Runtime **2.0.0**。当前 Manifest 声明兼容 0.41.0 和 2.0.0，但此 Catalog 具体选定的是 2.0.0，不能把兼容列表显示成已安装版本。

目标位置样例：

```text
<dataDir>/runtimes/kimi/2.0.0/<artifact-sha256>/kimi
```

`<dataDir>` 由当前运行环境确定；`<artifact-sha256>` 来自当前签名组合。实际界面应消费 Host 安装计划，不由 Web 自己拼路径。完整坐标在 ../evidence/current-combinations.json。

## 状态样例

| 状态 | Runtime 路径 | Runtime 版本 | Proxy 版本 | 操作/说明 |
| --- | --- | --- | --- | --- |
| 完全未准备 | 安装位置：Host 返回的计划位置 | 未安装 | 未安装 | 安装完整 Integration |
| 有源码 Proxy，无 Runtime | 安装位置：Host 返回的计划位置 | 未安装 | 0.3.2，标明开发来源 | 不把源码存在当成认证组合已激活 |
| 已准备，用户配置未完成 | Host 已核对路径 | Host 当前值 | Host 当前值 | 配置/登录是另一检查点，不假报 Ready |
| 正在更新 | 保留旧激活路径 | 保留旧当前版本 | 保留旧当前版本 | 目标变化与进度在操作区显示 |
| 校验失败 | 已知路径可用于诊断，但不能标可执行 | 不冒充兼容 | 当前已知值 | 明确失败原因，禁止用 latest 覆盖当前状态 |

## 不能混淆

- Kimi Code 的 Proxy 版本、Runtime 版本与 Gian App 版本不是同一个版本号。
- 最新发布版本不等于已安装版本；程序已安装不等于账号/端点配置完成。
- HOME 隔离不等于操作系统沙箱，选择已有 HOME 意味着共享其厂商状态。

依据：[统一合同](../CONTRACT.md)、[当前组合证据](../evidence/current-combinations.json)、[教程](tutorial.md)。

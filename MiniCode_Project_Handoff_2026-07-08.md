# MiniCode 项目完整交接文档

> 初始交接日期：2026-07-08  
> 最新补充日期：2026-07-13  
> 用途：切换到另一个 GPT 账号后继续开发  
> 当前项目定位：**纯通用 Agent / Coding Agent**，暂不进入量化金融、RAG、Web 前端或云部署。
> 最新状态：已进入 Phase 8 分支，OpenAI Chat Completions `stream=true` 已完成离线实现与单个真实 read-file 验收；全量 10 个 Live Case、TUI 人工验收和真实 Docker 仍未完成。

## 1. 当前核心目标

目前不要继续横向扩建通用框架，而是完成 **Phase 8：真实单 Agent 端到端运行与正式验收**。

必须证明以下完整链路：

```text
用户输入
→ 真实模型判断
→ 模型主动发起 Tool Call
→ Harness 执行工具
→ Tool Result 返回模型
→ 模型继续处理
→ 文件读取/修改
→ Shell 测试
→ 生成最终结果
→ Session 保存和恢复
```

当前底层 Harness、Trace、评测、Badcase、沙箱抽象、多 Agent 编排和真实 Planner 接入代码均已完成。Phase 8 已证明 `openai-chat-completions + stream=true` 可以完成 Text Smoke 和单个 read-file 工具闭环；**尚未完成的是全量真实 Live Eval、文件修改/审批、Shell、Session Resume、Memory、Skill、MCP、TUI 和真实 Docker 等完整验收。**

---

## 2. 仓库与路径

### 上游仓库

```text
https://github.com/LiuMengxuan04/MiniCode
```

### 本地目录

```text
工作根目录：
D:\MiniCode\minicode-reproduction

源码目录：
D:\MiniCode\minicode-reproduction\source

输出目录：
D:\MiniCode\minicode-reproduction\outputs
```

### 当前代码状态

```text
当前分支：
study/phase-8-real-agent-e2e

当前 Commit：
46369396dc6ddd0f6222aab3d9fde24aafc01ffd

预期 Git 状态：
存在未提交 Phase 8 流式实现改动；不要覆盖、回退或自动提交。
```

新账号接手后第一步执行：

```powershell
cd D:\MiniCode\minicode-reproduction\source

git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
```

---

## 3. 阶段与提交链

| 阶段 | 分支 | Commit | 核心成果 |
|---|---|---|---|
| Baseline | `main` | `3ec688f297fbc7e3a871113d1aa918d427c5817b` | 安装、Mock 启动、Agent Loop、219/219 |
| Phase 2 | `study/phase-2-harness` | `927512e360aa7d35ad63e15d608587459dfa8187` | Lint 修复、Harness 源码拆解 |
| Phase 3 | `study/phase-3-offline-trace` | `6bb009a08688769178fa7d2518eff77e745aabe5` | Trace、脱敏、6 场景、234/234 |
| Phase 4 | `study/phase-4-agent-evaluation` | `7cfaf84104ca5ba94f6d0fe5ec97b52f1e893eec` | Eval、Golden、Badcase、Replay、247/247 |
| Phase 5 | `study/phase-5-docker-sandbox` | `6327b6fd09cd8ae145cadc507f82ddea90941099` | Docker 沙箱抽象、12 个 Eval、277/277 |
| Phase 6 | `study/phase-6-planner-executor` | `1b98bfc4c524be097639a54e77dd8ebd8d009e59` | Planner–Executor、Checkpoint/Resume、305/305 |
| Phase 7 | `study/phase-7-real-model-planner` | `b32b440cf8c90feb2bbaeba09ad50d47e1a380da` | Live Planner Adapter、18 Case Dry Run、346/346 |
| Phase 8 | `study/phase-8-real-agent-e2e` | `46369396dc6ddd0f6222aab3d9fde24aafc01ffd` | Real Agent / Provider Probe / Chat Completions 流式兼容；改动未提交 |

---

## 4. 已完成能力

### 4.1 Baseline

已完成：

- `npm ci`
- `npm run check`
- `npm test`
- Mock 模式启动
- `model -> tool -> model`
- 隔离安装
- Git 源码保持干净

最初 Lint 失败是因为 `test/run-tests.mjs` 未命中 ESLint Flat Config 的 Node globals 覆盖，Phase 2 已修复。

### 4.2 Harness

已分析和实现的核心包括：

- Agent Loop
- Tool Registry
- Permission Manager
- Workspace 边界
- Diff 审批
- Memory
- Session
- Skill
- MCP
- Context Compaction
- TUI

关键结论：

```text
Agent = Model + Harness
```

### 4.3 Trace

已完成：

- 15 类 Trace 事件
- JSONL Trace
- Markdown 摘要
- summary / full 模式
- 脱敏
- Tool 成功和失败轨迹
- 大型 Tool Result 落盘
- Snip Compaction 观察

角色链路已经在 Mock 中验证：

```text
system
→ user
→ assistant_tool_call
→ tool_result
→ assistant
```

### 4.4 Agent Evaluation 与 Badcase

已完成：

- 10 个 Eval Case
- 分层 Assertion
- Failure Stage
- Golden Trajectory
- Baseline
- Metrics
- Badcase 保存
- Badcase Replay
- `REPRODUCED -> RESOLVED`

默认结果：

```text
10/10 passed
Trajectory Validity = 100%
Tool Selection Accuracy = 100%
Tool Argument Accuracy = 100%
Tool Result Return Rate = 100%
Termination Correctness = 100%
Security Violation Count = 0
```

### 4.5 Docker 沙箱

已完成源码和 Mock/静态验证：

- `CommandExecutor`
- `HostCommandExecutor`
- `DockerSandboxExecutor`
- Docker 参数安全检查
- Workspace Snapshot
- Output Limiter
- Timeout / Cleanup
- `run-command` 执行器注入
- `/status` 显示后端
- `debug:sandbox`
- `eval:sandbox`
- 12 个 Sandbox Case
- Dockerfile

安全参数：

```text
--network none
--user 10001:10001
--read-only
--cap-drop ALL
--security-opt no-new-privileges
--cpus 1
--memory 256m
--memory-swap 256m
--pids-limit 64
stdout/stderr 各 1 MiB
默认 timeout 30000ms
```

重要限制：

```text
当前机器 Docker CLI 不可用。
真实容器运行、docker inspect、网络阻断、资源限制和清理仍待真实验收。
```

显式选择 Docker 但不可用时：

```text
SANDBOX_UNAVAILABLE
```

绝对禁止回退 Host。

### 4.6 Planner–Executor

已完成：

- Planner
- Executor
- Orchestrator
- PlanValidator
- Scheduler
- RuleBasedReviewer
- Budget
- Retry / Replan
- Context Isolation
- Checkpoint / Resume
- Multi-Agent Trace
- Golden Plan / Trajectory
- Badcase Replay
- 14 个 Scenario

结果：

```text
14/14 passed
```

部分指标低于 1 是因为评测集中包含故意非法、拒绝、预算耗尽和失败场景，不是回归：

```text
Plan Validity Rate = 0.9286
Task Completion Rate = 0.5714
Replan Success Rate = 0.5000
Step Success Rate = 0.9000
```

稳定指标：

```text
Dependency Correctness Rate = 1.0000
Retry Recovery Rate = 1.0000
Forbidden Tool Block Rate = 1.0000
Budget Enforcement Rate = 1.0000
Checkpoint Recovery Rate = 1.0000
Context Isolation Rate = 1.0000
```

### 4.7 Live Planner

已完成：

- 独立 Live Planner Adapter
- Anthropic-compatible Planner Adapter
- Fake Provider
- 配置加载
- Live Budget
- Circuit Breaker
- Retry
- 一次 Repair
- 结构化 JSON Parser
- `planner-v1` Prompt 和 Hash
- 18 个 Planner Benchmark Case
- Prompt Injection / Tool Whitelist / Budget Case
- `eval:planner-live`
- `replay:planner-badcase`

当前状态：

```text
真实凭据未配置
Live 请求数 = 0
仅完成 18 Case Dry Run
346/346 tests
```

注意：Live Planner Adapter 只生成 `TaskPlan JSON`，不能替代完整单 Agent Adapter，因为它没有完整 Tool Calling / Tool Result 闭环。

---

## 5. 当前测试基线

继续开发前后必须保持：

```text
npm run check：通过
npm run lint：通过
npm test：至少 368/368，不得减少
Harness Eval：10/10
Sandbox Eval：12/12 静态/Mock
Multi-Agent Eval：14/14
Planner Dry Run：18 cases
```

允许新增测试；禁止通过删除测试降低总数。

---

## 6. Phase 8真实模型配置

当前真实 Provider 已确认：

```text
Base URL：
https://minai.asia

Model：
gpt-5.5
```

注意：

```text
MINICODE_REAL_BASE_URL 当前应填写 API host，不带 /v1。
当前 Adapter 会自行拼接 /v1/chat/completions 或 /v1/responses。
不要把环境变量改成 https://minai.asia/v1，否则会形成 /v1/v1/...。
```

协议兼容性最新结论：

1. Anthropic Messages：已真实请求，HTTP 401 `auth_failed`，不适用。
2. OpenAI Responses：可认证并返回 HTTP 200，但非流式 `status=completed` 且 `output=[]`，文本为空。
3. OpenAI Chat Completions：非流式 HTTP 200 但 `message.content` 缺失；`stream=true` 可从 `choices[0].delta.content` 正常返回文本。
4. 当前实际可用协议：`openai-chat-completions` + `stream: true`。

### PowerShell临时环境变量

每个新 PowerShell 窗口都要重新设置：

```powershell
$env:MINICODE_REAL_BASE_URL = "https://minai.asia"
$env:MINICODE_REAL_MODEL = "gpt-5.5"
$env:MINICODE_REAL_API_KEY = "<真实密钥>"
```

检查时只能输出 present/missing：

```powershell
@(
  "MINICODE_REAL_BASE_URL",
  "MINICODE_REAL_MODEL",
  "MINICODE_REAL_API_KEY"
) | ForEach-Object {
  "$_=" + ($(if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, "Process"))) { "missing" } else { "present" }))
}
```

### PowerShell永久环境变量

如果要写入当前 Windows 用户级环境变量，使用：

```powershell
[Environment]::SetEnvironmentVariable("MINICODE_REAL_BASE_URL", "https://minai.asia", "User")
[Environment]::SetEnvironmentVariable("MINICODE_REAL_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("MINICODE_REAL_API_KEY", "<真实密钥>", "User")
```

区别：

```text
$env:NAME = "value"
只设置当前 PowerShell 进程及其子进程，关闭窗口后失效。

[Environment]::SetEnvironmentVariable(..., "User")
写入用户级永久环境变量，新开的 PowerShell 才会读取；当前窗口通常还要同步设置一次 $env:NAME。
```

很多 Phase 8 后续操作是在 PowerShell 中完成的，包括环境变量修正、Provider Probe、最小真实请求、Text Smoke、read-file live case 和离线测试命令。这些操作不会全部体现在 Git 提交里，真实结果以 `outputs\phase-8-real-agent-e2e\PHASE8_REPORT.md` 和本文档补充为准。

真实密钥不得：

- 发给 GPT
- 写入 Codex Prompt
- 写入源码
- 写入 JSON 配置
- 写入报告
- 写入 Git
- 写入 Trace
- 写入 Session

只能输出：

```text
present / missing
```

---

## 7. Phase 8实施顺序

### 7.1 核对仓库

```powershell
cd D:\MiniCode\minicode-reproduction\source

git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
```

### 7.2 创建分支

```powershell
git switch -c study/phase-8-real-agent-e2e
```

当前分支已经存在：

```text
study/phase-8-real-agent-e2e
```

新账号接手后不要重复创建分支；先检查当前未提交改动，禁止覆盖。

### 7.3 协议探测

已完成多轮最小探测和对照验证。关键结论：

```text
Anthropic Messages：HTTP 401 auth_failed
OpenAI Responses：HTTP 200，但非流式输出为空
OpenAI Chat Completions：非流式 HTTP 200 但文本字段缺失
OpenAI Chat Completions stream=true：可用
```

继续 Phase 8 时不要再使用 `protocol=auto`，因为早期 auto 会优先 Anthropic 或走非目标协议。当前应显式使用：

```json
{
  "protocol": "openai-chat-completions",
  "stream": true,
  "streamToolCallIdPrefix": "fc_"
}
```

### 7.4 真实文本 Smoke

输入：

```text
只回复：MINICODE_REAL_MODEL_OK
```

最新状态：

```text
使用 openai-chat-completions + stream=true 已通过。
规范化后严格等于 MINICODE_REAL_MODEL_OK。
```

### 7.5 真实 Tool Calling

输入：

```text
请读取README.md，并告诉我文件第一行。必须使用文件读取工具，不要猜测。
```

必须出现：

```text
assistant_tool_call
→ tool_result
→ assistant
```

最新状态：

```text
单个 read-file live case 已通过。
真实轨迹包含：
assistant_tool_call
→ Harness 执行 read_file
→ tool_result
→ Tool Result 回填模型
→ 流式 assistant 最终文本
```

全量 10 个 Live Case 尚未运行。

### 7.6 文件修改与审批

在隔离工作区修复：

```javascript
export function add(a, b) {
  return a - b;
}
```

要求先展示 Unified Diff，经 PermissionManager 批准后写入。

### 7.7 Shell执行

Docker不可用，本阶段可显式设置：

```powershell
$env:MINI_CODE_COMMAND_EXECUTOR = "host"
```

但只能在隔离验收目录执行安全测试命令。

### 7.8 完整任务

Agent必须完成：

- 找出 calculator 问题
- 修改代码
- 执行测试
- 失败后继续修复
- 生成 `outputs/final-report.md`
- 不修改验收工作区外文件

### 7.9 Session / Resume

第一阶段只读取并总结，退出保存 Session；恢复后继续修复和测试。

### 7.10 Memory

`MINI.md`必须要求：

```text
修改代码后必须运行测试。
报告必须保存到outputs目录。
禁止修改验收工作区以外的文件。
```

### 7.11 Skill

创建：

```text
skills/project-verification/SKILL.md
```

流程：检查文件、运行测试、汇总变更、生成报告。

### 7.12 本地 Stdio MCP

仅暴露：

```text
get_project_summary
count_workspace_files
```

禁止 Shell、网络、写入和工作区外读取。

### 7.13 TUI

自动完成非TTY验收，人工检查：

```text
TUI打开
中文输入
流式输出
/help
/status
/tools
/skills
读取工具
修改审批
Shell审批
/compact
/resume
/exit
无残留MiniCode/MCP进程
```

最新状态：

```text
自动非TTY部分：Text Smoke 和单个 read-file 已通过。
人工 TUI checklist：仍 pending。
```

---

## 8. Phase 8隔离验收工作区

必须放在：

```text
D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\acceptance-workspace
```

建议结构：

```text
acceptance-workspace/
├── MINI.md
├── README.md
├── package.json
├── data/
│   └── numbers.txt
├── src/
│   └── calculator.js
├── tests/
│   └── calculator.test.js
├── skills/
│   └── project-verification/
│       └── SKILL.md
└── outputs/
```

真实 Agent不得直接修改：

```text
D:\MiniCode\minicode-reproduction\source
用户Home
Codex配置
其他项目
Git全局配置
Windows注册表
```

---

## 9. 现有命令

```powershell
npm run check
npm run lint
npm test

npm run eval:harness -- --all
npm run eval:sandbox -- --all
npm run eval:multi-agent -- --all

npm run eval:planner-live -- `
  --config config/planner-live.example.json `
  --dry-run
```

Phase 8已新增：

```powershell
npm run eval:agent-live
npm run probe:real-agent
scripts/start-real-agent.ps1
config/real-agent.example.json
```

当前 Provider 推荐配置已经写入非敏感示例配置：

```json
{
  "protocol": "openai-chat-completions",
  "stream": true,
  "streamToolCallIdPrefix": "fc_"
}
```

单个 read-file live case 命令：

```powershell
npm run eval:agent-live -- --config config/real-agent.example.json --case read-file --output D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e --max-requests 8 --max-tool-calls 6 --no-save-raw
```

全量 10 个 live cases 命令，尚未运行：

```powershell
npm run eval:agent-live -- --config config/real-agent.example.json --all --output D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e --max-requests 30 --max-tool-calls 20 --no-save-raw
```

启动真实 Agent TUI：

```powershell
.\scripts\start-real-agent.ps1 -Workspace D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\acceptance-workspace
```

---

## 10. 安全与Git约束

禁止：

```text
git push
git merge
直接修改main
```

不得提交：

- `outputs/`
- 真实密钥
- 真实配置
- Live Trace
- 原始模型响应
- Session
- MCP运行文件
- 缓存
- Badcase运行实例
- 验收工作区运行产物
- 绝对用户路径

Tool Call必须来自真实模型，禁止Harness硬编码替模型调用工具。

---

## 11. Docker状态

```text
Docker CLI：不可用
Docker daemon：不可访问
真实容器验收：pending
```

Phase 8不以Docker为阻塞条件，但必须保持：

```text
MINI_CODE_COMMAND_EXECUTOR=docker
且Docker不可用
→ SANDBOX_UNAVAILABLE
→ 禁止回退Host
```

---

## 12. 重要输出报告

```text
D:\MiniCode\minicode-reproduction\outputs\REPRODUCTION_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-2-harness\PHASE2_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-3-offline-trace\PHASE3_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-4-agent-evaluation\PHASE4_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-5-docker-sandbox\PHASE5_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-6-planner-executor\PHASE6_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-7-real-model-planner\PHASE7_REPORT.md
```

Phase 8预期：

```text
D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\PHASE8_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\USER_GUIDE.md
```

上述两个文件已经存在，但位于 `outputs` 下，不应提交 Git。当前报告记录：

```text
真实请求累计：13
实际可用协议：openai-chat-completions + stream=true
Text Smoke：通过
单个 read-file live case：通过
全量 10 个 Live Case：未运行
人工 TUI 验收：pending
```

---

## 13. Codex本地会话

旧Codex会话文件仍存在：

```text
C:\Users\86155\.codex\sessions\2026\07\07\rollout-2026-07-07T15-18-33-019f3b71-60de-7782-ab9c-7bcb612b474b.jsonl
```

Session ID：

```text
019f3b71-60de-7782-ab9c-7bcb612b474b
```

CLI恢复：

```powershell
codex resume 019f3b71-60de-7782-ab9c-7bcb612b474b
```

新GPT账号无需依赖旧会话，以Git、报告和本交接文档为准。

---

## 14. 核心代码模块

### 原始Agent/Harness

```text
src/index.ts
src/agent-loop.ts
src/types.ts
src/tool.ts
src/tools/
src/permissions.ts
src/workspace.ts
src/file-review.ts
src/session.ts
src/memory.ts
src/skills.ts
src/mcp.ts
src/compact/
src/tty-app.ts
src/tui/
```

### Trace

```text
src/debug/
scripts/debug-agent-loop.ts
scripts/analyze-harness-trace.ts
```

### Evaluation

```text
src/evaluation/
scripts/evaluate-agent-harness.ts
scripts/replay-agent-badcase.ts
evals/
```

### Execution/Sandbox

```text
src/execution/
sandbox/docker/Dockerfile
scripts/debug-docker-sandbox.ts
scripts/evaluate-docker-sandbox.ts
```

### Multi-Agent

```text
src/multi-agent/
scripts/debug-planner-executor.ts
scripts/evaluate-planner-executor.ts
scripts/replay-multi-agent-badcase.ts
evals/multi-agent/
```

### Live Planner

以仓库实际扫描为准，包含：

```text
Live Planner Adapter
Planner Output Parser
planner-v1 Prompt
Live Budget / Circuit Breaker
18个Planner Benchmark Case
evaluate-live-planner.ts
replay-planner-badcase.ts
planner-live.example.json
```

### Real Agent / Phase 8

当前 Phase 8 相关源码和脚本：

```text
src/real-agent/index.ts
src/real-agent/config.ts
src/real-agent/adapters.ts
src/real-agent/probe.ts
src/real-agent/sse.ts
scripts/probe-real-agent-provider.ts
scripts/evaluate-agent-live.ts
scripts/start-real-agent.ps1
config/real-agent.example.json
test/real-agent.test.ts
```

当前未提交流式实现要点：

```text
OpenAI Chat Completions 显式 stream=true
严格 SSE 解析：text/event-stream、CRLF/LF、多 event/chunk、跨 chunk event、[DONE]
choices[].delta.content 文本聚合
choices[].delta.tool_calls[] 工具调用聚合
工具 id/name/arguments 分片拼接
arguments 在流结束后 JSON 解析
streamToolCallIdPrefix 配置项，当前 Provider 使用 fc_
非 2xx JSON 错误、非 SSE Content-Type、提前断流、Abort/timeout 的脱敏错误处理
```

最近人工 review 后新增的边界测试：

```text
parses CRLF split across network chunk boundaries without false event boundary
does not duplicate a complete streamed tool call id prefix
rejects a streamed response that times out while reading
```

修复结论：

```text
CRLF 跨 chunk 测试修复前失败，已最小修复 src/real-agent/sse.ts。
Tool Call ID 完整前缀幂等测试修复前通过。
SSE timeout 测试修复前通过。
```

---

## 15. 新GPT接手指令

下面第一段是 2026-07-08 的历史接手指令，只用于理解当时上下文；2026-07-09 之后接手应使用后面的更新版指令。

```text
你现在接手一个已经开发到Phase 7的MiniCode项目。不要重新克隆，不要重做Phase 1-7，不要进入量化金融、RAG、Web前端或云部署。

请先扫描并核对：
- 源码：D:\MiniCode\minicode-reproduction\source
- 当前分支应为 study/phase-7-real-model-planner
- 当前Commit应为 b32b440cf8c90feb2bbaeba09ad50d47e1a380da
- Git应干净
- npm test基线为346/346
- Harness Eval 10/10
- Sandbox Eval 12/12静态/Mock
- Multi-Agent Eval 14/14
- Planner Dry Run 18 cases

当前唯一核心目标是Phase 8：把MiniCode运行成真实、纯粹、可日常使用的单Agent。必须完成真实模型文本响应、真实Tool Calling、Tool Result回填、文件修改审批、Shell测试、完整代码修复任务、Session Resume、Memory、Skill、本地Stdio MCP和TUI验收。

真实Agent必须在隔离验收工作区运行，不得修改MiniCode源码。当前Docker不可用，真实Docker不作为阻塞条件，但显式选择Docker失败时不得回退Host。

真实模型配置通过以下环境变量提供，只检查present/missing，不输出值：
- MINICODE_REAL_BASE_URL
- MINICODE_REAL_MODEL
- MINICODE_REAL_API_KEY

先执行仓库、分支、Commit和测试基线检查，然后创建：
study/phase-8-real-agent-e2e

不要push，不要merge，不要提交outputs、密钥、Live响应、Trace、Session或验收运行产物。

完整交接文档由用户提供。现在先扫描仓库和已有Phase 7代码，输出实际状态与Phase 8实施计划，不要重复实现已有模块。
```

如果是在 2026-07-09 之后接手，应改用以下更新版指令：

```text
你现在接手 MiniCode Phase 8 分支。不要重新克隆，不要重做 Phase 1-7，不要回退当前未提交的 Phase 8 流式实现，不要提交、push 或 merge。

当前分支应为 study/phase-8-real-agent-e2e，HEAD 为 46369396dc6ddd0f6222aab3d9fde24aafc01ffd。工作树预期存在未提交改动：Real Agent 配置、OpenAI Chat Completions streaming adapter、SSE parser、real-agent tests，以及 config/real-agent.example.json。

当前 Provider 的实际可用协议是 openai-chat-completions + stream=true。MINICODE_REAL_BASE_URL 应填写 API host，不带 /v1；API key 只从环境变量读取，只能检查 present/missing。

已完成：Streaming Text Smoke 严格匹配 MINICODE_REAL_MODEL_OK；单个 read-file live case 通过；离线测试 npm test 368/368 通过；check/lint/secret scan 通过。

未完成：全量 10 个 Agent Live Eval、文件修改审批真实验收、Shell 真实验收、Session Resume 真实验收、Memory/Skill/MCP live 验收、TUI 人工验收、真实 Docker 验收。

下一步先审查当前 diff 和 PHASE8_REPORT.md，不要直接发真实请求。确认后再决定是否运行全量 live eval。
```

---

## 16. 最终交接结论

当前项目已经具备：

- 单Agent Mock Harness
- Tool Registry
- 权限审批
- Memory / Session / Skill / MCP
- Trace
- Compaction
- Evaluation
- Badcase / Replay
- Docker Sandbox抽象
- Planner–Executor
- Checkpoint / Resume
- Live Planner Adapter
- Live Planner Benchmark框架
- Real Agent Provider Probe
- OpenAI Chat Completions 流式文本与工具调用
- SSE 解析器和离线边界测试
- 单个真实 read-file 工具闭环

当前关键缺口已经从“真实单 Agent 端到端工具闭环完全缺失”缩小为：

```text
全量真实 Live Eval 和人工 TUI / Docker / Session / MCP 等验收尚未完成
```

新账号下一步仍只做 Phase 8，不再横向扩建通用框架。

---

## 17. 2026-07-09 Phase 8补充摘要

### 17.1 当前Git状态

```text
Branch：study/phase-8-real-agent-e2e
HEAD：46369396dc6ddd0f6222aab3d9fde24aafc01ffd
状态：存在未提交 Phase 8 改动
```

当前 `git status --short` 预期包含：

```text
 M config/real-agent.example.json
 M src/real-agent/adapters.ts
 M src/real-agent/config.ts
 M src/real-agent/index.ts
 M test/real-agent.test.ts
?? MiniCode_Project_Handoff_2026-07-08.md
?? src/real-agent/sse.ts
```

`MiniCode_Project_Handoff_2026-07-08.md` 当前在 Git 中显示为 untracked；这是移交文档本身，不代表源码回归。

### 17.2 真实请求账本

Phase 8 报告中记录的真实请求累计为 13 次：

```text
1  Anthropic Messages provider probe：HTTP 401 auth_failed
2  OpenAI Responses forced probe：HTTP 401 auth_failed
3  OpenAI Responses forced probe retry：HTTP 401 auth_failed
4  OpenAI Responses after env rewrite：HTTP 200 supported
5  OpenAI Responses Text Smoke adapter path：HTTP 200 assistant text length 0
6  OpenAI Responses structure diagnostic：HTTP 200 status=completed output=[]
7  OpenAI Responses minimal string input：HTTP 200 status=completed output=[]
8  OpenAI Chat Completions non-stream minimal text：HTTP 200 message.content absent
9  OpenAI Chat Completions streaming Text Smoke：HTTP 200 strict match true
10 OpenAI Chat Completions streaming read-file first model turn：real tool call
11 OpenAI Chat Completions streaming read-file second turn：tool-call id prefix compatibility error
12 OpenAI Chat Completions streaming read-file retry first provider request：real read_file tool call
13 OpenAI Chat Completions streaming read-file retry second provider request：final assistant text
```

不要在移交文档、报告或聊天中写入原始响应、完整 URL 路径、请求头或密钥。

### 17.3 最新验证结果

最近一次离线验证结果：

```text
node --import tsx --test test\real-agent.test.ts：22/22 passed
npm run check：passed
npm run lint：passed
npm test：368/368 passed
git diff --check：passed，仅有 Git LF/CRLF 提示
Secret Scan：passed
```

没有运行真实 API 请求；没有运行全量 Live Eval；没有提交。

### 17.4 PowerShell操作记录说明

用户后续在 PowerShell 中做过以下关键操作：

```text
设置/改写 MINICODE_REAL_* 环境变量
确认 present/missing
将 Base URL 从 minai.asia / www.minai.asia 方向反复核对
按 Provider 建议确认 Chat Completions stream=true 可返回 delta.content
运行 Provider Probe、Text Smoke、结构诊断和 read-file live case
运行离线测试和 Secret Scan
```

这些操作大多不会改变 Git tracked 文件。接手者不能只看 Git commit 判断 Phase 8 进度，必须同时阅读：

```text
D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\PHASE8_REPORT.md
D:\MiniCode\minicode-reproduction\outputs\phase-8-real-agent-e2e\USER_GUIDE.md
D:\MiniCode\minicode-reproduction\source\MiniCode_Project_Handoff_2026-07-08.md
```
---

## 18. 2026-07-10 至 2026-07-13 最新操作补充

### 18.1 全量 10 Case Live Eval 尝试

曾准备执行 Phase 8 全量 10 Case Live Eval，但只完成 preflight，未发起真实 API 请求。

当时执行并核对：

```powershell
cd D:\MiniCode\minicode-reproduction\source

git status --short
git branch --show-current
git rev-parse HEAD
```

结果：

```text
Branch：study/phase-8-real-agent-e2e
HEAD：46369396dc6ddd0f6222aab3d9fde24aafc01ffd
工作树：仍存在预期的未提交 Phase 8 改动
```

当时当前 PowerShell 进程中的真实 Provider 环境变量检查结果：

```text
MINICODE_REAL_BASE_URL=missing
MINICODE_REAL_MODEL=missing
MINICODE_REAL_API_KEY=missing
```

按照安全停止规则，因任一必需变量 missing，立即停止：

```text
未运行 npm run eval:agent-live
未运行 Provider Probe
未发起真实 Provider/API 请求
未启动 TUI
未保存原始响应
未修改源码
未提交 Git
```

当时结论：

```text
FULL LIVE EVAL INCONCLUSIVE
```

原因不是代码失败，而是当前 PowerShell 会话未设置 `MINICODE_REAL_*`。

下一次运行全量 Live Eval 前，必须在同一个 PowerShell 会话中重新设置或确认：

```powershell
$env:MINICODE_REAL_BASE_URL = "https://minai.asia"
$env:MINICODE_REAL_MODEL = "gpt-5.5"
$env:MINICODE_REAL_API_KEY = "<真实密钥>"
```

然后只输出 present/missing 检查结果，不输出实际值。

### 18.2 Codex 本地配置位置

当前机器上 Codex 用户级配置文件位置：

```text
C:\Users\86155\.codex\auth.json
C:\Users\86155\.codex\config.toml
```

最近只检查了存在性：

```text
auth.json=present
config.toml=present
CODEX_HOME=missing
```

含义：

```text
auth.json：Codex 登录/认证相关文件，可能包含敏感凭据。
config.toml：Codex CLI 用户级配置文件，通常包含模型、sandbox、approval、MCP、project trust 等设置。
CODEX_HOME=missing：当前使用默认用户级目录 C:\Users\86155\.codex。
```

安全要求：

```text
不要读取或复制 auth.json 内容。
不要把 auth.json 或 config.toml 提交到 MiniCode 仓库。
不要把其中任何凭据写入 Prompt、报告、Trace、Session 或 Git。
MiniCode 项目配置仍以 D:\MiniCode\minicode-reproduction\source 下的源码和 config/*.json 为准。
```

### 18.3 当前接手状态

截至 2026-07-13，最新状态：

```text
Branch：study/phase-8-real-agent-e2e
HEAD：46369396dc6ddd0f6222aab3d9fde24aafc01ffd
真实可用协议：openai-chat-completions + stream=true
Text Smoke：此前已通过
单个 read-file live case：此前已通过
全量 10 Case Live Eval：尚未运行成功，最近一次因环境变量 missing 在 preflight 停止
人工 TUI 验收：pending
真实 Docker 验收：pending
```

当前 `git status --short` 预期仍包含：

```text
 M config/real-agent.example.json
 M src/real-agent/adapters.ts
 M src/real-agent/config.ts
 M src/real-agent/index.ts
 M test/real-agent.test.ts
?? MiniCode_Project_Handoff_2026-07-08.md
?? src/real-agent/sse.ts
```

下一账号接手后的唯一建议：

```text
先确认 MINICODE_REAL_* 在当前 PowerShell 会话中为 present。
若三项均 present，再按 USER_GUIDE.md 运行一次全量 10 Case Live Eval。
不要重复 Provider Probe，不要修改源码，不要自动提交。
```


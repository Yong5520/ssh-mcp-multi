# ssh-mcp-multi — 多主机 SSH MCP Server

基于 [ssh-mcp](https://github.com/tufantunc/ssh-mcp) 改造的多主机版本，通过 YAML 配置文件管理 1~数百台远程主机，让 Claude Code 能按需 SSH 到任意目标机器执行命令。

## 架构概览

```
Claude Code
  │
  ▼ (MCP stdio)
ssh-mcp-multi
  │
  ├── host: n110  ──SSH──▶  10.31.10.110
  ├── host: n205  ──SSH──▶  10.31.10.205
  ├── host: n44   ──SSH──▶  10.113.1.44
  └── ...                    (按需建连，连接复用)
```

核心改动：
- 新增 `--hosts-file` 参数，从 YAML 文件加载主机清单
- 内置连接池（`ConnectionPool`），按需建立连接、自动复用
- `exec` / `sudo-exec` 工具增加 `host` 参数，指定目标主机
- 向后兼容原版单主机模式

## 功能特性

- **多主机管理** — 通过 YAML 配置管理任意数量的远程主机
- **双认证模式** — 支持密码认证和 SSH 密钥认证
- **提权支持** — 支持 sudo 和 su 两种提权方式
- **连接池** — 自动复用 SSH 连接，按需建立和重连
- **安全过滤** — 内置 18 条危险命令拦截规则，防止 AI 误操作
- **多安全级别** — standard / strict / readonly / disabled 四级可选
- **审计日志** — 所有执行的命令按主机记录，包含被拦截的命令

## 前置条件

| 依赖 | 版本要求 |
|------|---------|
| Node.js | >= 18 |
| Claude Code CLI | 最新版 |
| 网络连通 | 本机到所有目标主机的 SSH 端口可达 |

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/YOUR_USERNAME/ssh-mcp-multi.git
cd ssh-mcp-multi
```

### 2. 创建配置文件

```bash
# 创建主机清单（从示例文件复制）
cp hosts.yaml.example hosts.yaml
chmod 600 hosts.yaml

# 创建安全配置（可选，不创建则使用内置默认规则）
cp security.yaml.example security.yaml
```

### 3. 编辑主机清单

编辑 `hosts.yaml`，填入你的目标主机信息：

```yaml
hosts:
  n110:
    host: 10.31.10.110
    port: 22
    user: aiops
    password: "your-password"

  n205:
    host: 10.31.10.205
    port: 22
    user: aiops
    key: /home/yourname/.ssh/id_rsa    # 密钥认证
```

### 4. 运行安装脚本

```bash
bash install.sh
```

脚本会自动：安装依赖 → 编译 TypeScript → 注册 MCP server

### 5. 重启 Claude Code

退出当前会话，重新启动 Claude Code，MCP 工具即可使用。

## 手动安装（不使用脚本）

```bash
# 安装依赖并编译
npm install
npm run build

# 注册到 Claude Code（多主机模式）
claude mcp add --transport stdio ssh-mcp -- \
  node /path/to/sshserver/build/index.js -- \
  --hosts-file=/path/to/hosts.yaml \
  --security-file=/path/to/security.yaml \
  --timeout=30000 \
  --maxChars=2000

# 或单主机模式（向后兼容）
claude mcp add --transport stdio ssh-mcp -- \
  node /path/to/sshserver/build/index.js -- \
  --host=10.31.10.110 --user=aiops --password=xxx \
  --timeout=30000
```

## hosts.yaml 配置详解

### 完整格式

```yaml
hosts:
  <主机别名>:                    # 你在对话中引用的名称，如 n44、db-master
    host: <IP 或域名>            # 必填，SSH 目标地址
    port: 22                     # 可选，SSH 端口，默认 22
    user: <用户名>               # 必填，SSH 登录用户
    password: "<密码>"           # 密码认证（与 key 二选一）
    key: /path/to/private_key   # 密钥认证（与 password 二选一）
    sudoPassword: "<sudo密码>"   # 可选，用于 sudo-exec 工具
    suPassword: "<root密码>"     # 可选，建立持久 root shell
    timeout: 120000              # 可选，命令超时(ms)，覆盖全局默认
```

### 认证方式

**密码认证：**
```yaml
n110:
  host: 10.31.10.110
  user: admin
  password: "MyP@ssw0rd"
```

**密钥认证：**
```yaml
n205:
  host: 10.31.10.205
  user: deploy
  key: /home/deploy/.ssh/id_rsa
```

`key` 支持相对路径（相对于 hosts.yaml 所在目录）和绝对路径。

### 提权方式

**sudo 提权**（每次命令单独 sudo）：
```yaml
n110:
  host: 10.31.10.110
  user: aiops
  password: "userpass"
  sudoPassword: "sudopass"
```

**su 提权**（建立持久 root shell，后续命令都以 root 执行）：
```yaml
n110:
  host: 10.31.10.110
  user: aiops
  password: "userpass"
  suPassword: "rootpass"
```

### 批量配置技巧

如果多台机器使用相同凭据，可以用脚本生成：

```bash
# 生成 n1-n200 的配置（相同用户名密码，IP 按规律递增）
for i in $(seq 1 200); do
  cat <<EOF
  n$i:
    host: 10.31.10.$i
    user: aiops
    password: "shared-password"
EOF
done > hosts.yaml
# 手动加上 hosts: 头部
```

## 使用方式

安装完成后，在 Claude Code 对话中直接用自然语言指定主机：

```
去 n110 看看磁盘使用情况
n205 上 nginx 服务状态怎么样
查一下 n44 的系统负载
在 n110 和 n205 上分别执行 uptime
帮我比较 n110 和 n205 的内存使用
```

Claude 会自动调用 `exec(host="n110", command="df -h")` 这样的 MCP 工具调用。

## 安全控制

ssh-mcp-multi 内置命令安全过滤，防止 AI 执行危险操作。**即使不创建配置文件，默认规则也会生效**，拦截 `rm -rf /`、`shutdown`、`mkfs` 等高危命令。

### 快速开始

```bash
# 复制示例配置并按需修改
cp security.yaml.example security.yaml
vim security.yaml

# 重启 Claude Code 会话生效
```

### 安全等级

| 等级 | 说明 |
|------|------|
| `standard` | 黑名单模式，拦截已知危险命令（**默认**） |
| `strict` | 白名单模式，只允许明确列出的命令 |
| `readonly` | 只允许读操作（ls/cat/grep/ps 等） |
| `disabled` | 不过滤（谨慎使用） |

### 配置文件格式（security.yaml）

```yaml
level: standard

# 追加黑名单（内置默认规则 + 这里的规则）
blocked:
  - pattern: '(^|\s|;|&&|\|\|)\s*crontab\s+(-e|-r)\b'
    reason: "禁止修改 crontab"

# 白名单（strict/readonly 模式生效）
allowed:
  - pattern: '^(ls|cat|grep|find|ps|df|top|uptime)\b'

# 按主机覆盖
hosts:
  prod-db-01:
    level: readonly
  dev-01:
    level: disabled
```

### 默认拦截规则（18 条）

以下规则在 `standard` 模式下默认生效，无需额外配置。

#### 文件系统破坏（4 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 1 | critical | 禁止删除根目录 | `rm -rf /` |
| 2 | critical | 禁止删除 `/etc` 下的系统文件 | `rm -rf /etc` |
| 3 | critical | 禁止格式化文件系统 | `mkfs.ext4 /dev/sda1` |
| 4 | critical | 禁止直接写块设备 | `dd if=/dev/zero of=/dev/sda` |

#### 系统控制（3 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 5 | critical | 禁止关机 | `shutdown -h now` / `poweroff` / `halt` |
| 6 | critical | 禁止重启 | `reboot` |
| 7 | critical | 禁止切换到关机/重启运行级别 | `init 0` / `init 6` |

#### 网络破坏（2 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 8 | critical | 禁止清空防火墙规则 | `iptables -F` |
| 9 | high | 禁止关闭网络接口 | `ip link set eth0 down` |

#### 用户/权限操作（4 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 10 | critical | 禁止修改 root 密码 | `passwd root` |
| 11 | critical | 禁止删除 root 用户 | `userdel root` |
| 12 | high | 禁止在根路径设置极端权限 | `chmod 777 /` / `chown 000 /` |
| 18 | high | 禁止在根路径设置 777 权限 | `chmod 777 /`（补充规则） |

#### 包管理卸载（1 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 13 | critical | 禁止卸载关键系统包 | `apt remove kernel` / `yum remove systemd` / `dnf remove sudo` |

#### 覆盖关键系统文件（1 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 14 | critical | 禁止覆盖 `/etc/passwd`、`/etc/shadow`、`/etc/sudoers`、`/etc/ssh/sshd_config` | `echo "x" > /etc/passwd` |

#### 内核模块（1 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 15 | high | 禁止卸载内核模块 | `modprobe -r nfs` |

#### 混淆/绕过（2 条）

| # | 严重级别 | 拦截说明 | 典型命令示例 |
|---|---------|---------|-------------|
| 16 | critical | 禁止通过 `eval`/`bash -c` 间接执行危险命令 | `eval "rm -rf /"` / `bash -c "shutdown"` |
| 17 | critical | 禁止通过编码/压缩管道绕过执行 | `base64 -d | bash` / `gunzip -c evil.gz | sh` |

#### 严重级别分布

- **critical**（15 条）：文件破坏、系统控制、网络清空、用户操作、包卸载、文件覆盖、混淆绕过
- **high**（3 条）：网络接口关闭、极端权限、内核模块卸载

### 被拦截时的行为

命令被拦截后，AI 会收到明确的拒绝信息（包含具体原因），不会执行任何操作。同时会在日志中以 `BLOCKED` 模式记录，便于审计。

## 审计日志

ssh-mcp-multi 自动记录所有命令执行情况，包括正常执行和被安全规则拦截的命令，便于事后审计和问题排查。

### 日志存储位置

日志文件存储在项目目录下的 `logs/` 文件夹中，**按主机名分文件**：

```
logs/
├── n110.log    # 主机 n110 的命令日志
├── n205.log    # 主机 n205 的命令日志
└── ...
```

多主机模式下，日志目录位于 `hosts.yaml` 同级目录的 `logs/`；单主机模式下位于当前工作目录的 `logs/`。目录不存在时会自动创建。

### 日志格式

每条日志占一行，采用结构化格式：

```
[时间戳] 模式 cmd="命令内容" desc="AI 描述"
```

| 字段 | 说明 |
|------|------|
| 时间戳 | `YYYY-MM-DD HH:mm:ss` 格式，使用 Asia/Shanghai 时区 |
| 模式 | `exec`（普通执行）、`sudo`（sudo 执行）、`BLOCKED`（被安全规则拦截） |
| cmd | 实际执行的命令内容 |
| desc | AI 提交的操作描述（可选） |

### 日志示例

```log
[2026-05-25 14:28:50] exec cmd="hostname && uptime" desc="查看 n110 主机信息"
[2026-05-25 14:28:51] sudo cmd="whoami" desc="以 root 身份确认当前用户"
[2026-05-25 15:44:20] BLOCKED cmd="rm -rf /etc" desc="清理配置文件"
[2026-05-25 15:35:24] exec cmd="df -h" desc="查看磁盘使用情况"
```

### 记录范围

| 事件类型 | 日志标记 | 说明 |
|---------|---------|------|
| 普通命令执行 | `exec` | 通过 `exec` 工具执行的命令 |
| sudo 命令执行 | `sudo` | 通过 `sudo-exec` 工具执行的命令 |
| 命令被拦截 | `BLOCKED` | 触发安全规则被阻止的命令 |

所有日志以 append 方式写入，不会覆盖历史记录。`logs/` 目录已在 `.gitignore` 中排除，不会提交到 Git 仓库。

## 项目结构

```
sshserver/
├── src/
│   └── index.ts                # 主源码
├── build/
│   └── index.js                # 编译产物（.gitignore）
├── hosts.yaml                  # 主机清单配置（.gitignore，含敏感信息）
├── hosts.yaml.example          # 主机清单示例模板
├── security.yaml               # 安全控制配置（.gitignore，可含自定义策略）
├── security.yaml.example       # 安全配置示例模板
├── install.sh                  # 一键安装脚本
├── package.json
├── tsconfig.json
└── README.md
```

## 全局参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--hosts-file` | 无 | YAML 主机清单路径（多主机模式） |
| `--host` | 无 | 单台主机 IP（单主机模式） |
| `--user` | 无 | 单台主机用户名 |
| `--password` | 无 | 单台主机密码 |
| `--key` | 无 | 单台主机密钥路径 |
| `--timeout` | 60000 | 全局默认命令超时(ms) |
| `--maxChars` | 1000 | 命令最大字符长度 |
| `--security-file` | 无 | 安全配置文件路径（不指定时使用内置默认规则） |
| `--disableSudo` | false | 禁用 sudo-exec 工具 |

## 常见问题

### MCP 连接失败

```bash
# 检查 MCP 状态
claude mcp list

# 手动测试 MCP 是否能启动
node build/index.js --hosts-file=hosts.yaml --timeout=30000 --maxChars=2000
# 如果输出 "SSH MCP Server (Multi-Host) running" 并等待输入，说明启动正常
```

### 主机连不上

```bash
# 先手动测试 SSH 连通性
ssh aiops@10.31.10.110 -p 22    # 密码认证
ssh -i ~/.ssh/id_rsa aiops@10.31.10.205   # 密钥认证
```

### 新增/修改主机后不生效

修改 `hosts.yaml` 后需要**重启 Claude Code 会话**，因为 MCP server 在启动时读取配置。

### 凭据安全建议

- 文件权限设置为 `600`：`chmod 600 hosts.yaml`
- 不要将 `hosts.yaml` 提交到 Git 仓库（已在 .gitignore 中排除）
- 生产环境推荐使用密钥认证而非明文密码
- `security.yaml` 如包含内部策略信息也应排除（已在 .gitignore 中排除）

## License

MIT

---
name: cluster-node-init
description: |
  集群节点初始化技能 — 在机器重装系统后，自动完成 Docker 安装配置、数据盘挂载、驱动依赖安装、NFS 挂载、CUDA/SDK/驱动安装、K8s 集群加入等一整套初始化流程。
  当用户提到"初始化机器"、"新机器配置"、"节点初始化"、"重装系统后配置"、"加入集群"、"初始化节点"、"setup node"、"init node"、"新机器上线"、"node init"、"cluster init" 时，务必使用此技能。即使用户只是提到了其中某个步骤（如"帮我装驱动"、"挂载数据盘"），也应建议使用此技能完成完整初始化。
---

# 集群节点初始化

本技能通过 SSH MCP 工具在远程目标机器上完成重装系统后的全套初始化配置。

## 前置条件

- 目标机器已通过 `hosts.yaml` 配置好 SSH 连接信息
- 目标机器操作系统为 Ubuntu/Debian
- 当前用户具有 sudo 权限（`hosts.yaml` 中配置了 `sudoPassword`）
- 网络可访问内部镜像源和 NFS 服务器

## 初始化流程

执行前先向用户确认目标主机名（对应 `hosts.yaml` 中的别名，如 `n110`、`n205`）。

整个流程分为以下阶段，每个阶段执行完毕后向用户汇报结果，遇到错误立即停止并等待用户指示。

### 阶段 1：系统基础配置

#### 1.1 更新镜像源

```bash
apt update
```

使用 `sudo-exec` 执行。

#### 1.2 安装并启用 Docker

```bash
apt install -y docker.io
systemctl enable docker
```

#### 1.3 配置 Docker

写入 Docker 配置文件 `/etc/docker/daemon.json`：

```json
{
    "data-root":"/data1/var/lib/docker",
    "exec-opts": ["native.cgroupdriver=systemd"],
    "debug": true,
    "insecure-registries": [
        "harbor.iluvatar.com.cn:10443",
        "zibo-harbor.iluvatar.com.cn",
        "registry.iluvatar.com.cn:10443"
    ]
}
```

创建 K8s 信任目录：

```bash
mkdir -p /etc/docker/certs.d/zibo.iluvatar.com
```

添加解析记录：

```bash
echo "10.31.10.90 zibo.iluvatar.com" >> /etc/hosts
```

> 先检查 `/etc/hosts` 中是否已存在该条目，避免重复添加。用 `grep` 判断，不存在才追加。

#### 1.4 重启 Docker

```bash
systemctl restart docker
```

#### 1.5 关闭内核自动更新

```bash
systemctl stop unattended-upgrades.service
systemctl disable unattended-upgrades.service
```

### 阶段 2：数据盘挂载

#### 2.1 检查磁盘

先确认数据盘设备名和文件系统类型：

```bash
lsblk
```

常见情况：
- NVMe 盘：`/dev/nvme0n1`（ext4）或 `/dev/nvme0n1p1`（xfs 分区）
- 如果磁盘已有文件系统，直接挂载；如果没有，询问用户是否需要格式化

#### 2.2 创建挂载点并挂载

```bash
mkdir -p /data1
```

根据 `lsblk` 和 `blkid` 的结果，选择正确的设备和文件系统类型写入 `/etc/fstab`。

**ext4 的 fstab 条目：**
```
/dev/nvme0n1 /data1 ext4 defaults 0 1
```

**xfs 的 fstab 条目（带分区）：**
```
/dev/nvme0n1p1 /data1 xfs defaults 0 1
```

> 不要盲写 fstab。先 `cat /etc/fstab` 检查是否已有条目，避免重复。如果 `/data1` 已在 fstab 中，跳过写入，直接 `mount -a`。

写入后执行：

```bash
mount -a
```

验证挂载成功：

```bash
df -h /data1
```

### 阶段 3：驱动依赖安装

```bash
apt-get install -y gcc kmod systemd dkms nfs-common python3-pip make cmake unzip openssl
pip3 install numpy==1.23 -i https://pypi.tuna.tsinghua.edu.cn/simple
```

> 如果 `apt-get install` 有部分包已安装，输出中会显示 "already installed"，这是正常的，不影响后续步骤。

### 阶段 4：NFS 挂载与驱动安装

#### 4.1 挂载 NFS

```bash
mkdir -p /mnt/tmpnfs
mount -t nfs 10.31.10.213:/nfs_share /mnt/tmpnfs
```

验证：

```bash
ls /mnt/tmpnfs/
```

应能看到 `cuda_headers` 和 `4.4.0` 等目录。

#### 4.2 安装 CUDA Headers

```bash
cd /mnt/tmpnfs/cuda_headers && bash install-cuda-header_10.2.sh
```

#### 4.3 安装 SDK

询问用户需要安装的 SDK 版本（如 `4.4.0`、`4.3.8` 等），对应 NFS 目录 `/mnt/tmpnfs/版本号/`：

```bash
bash /mnt/tmpnfs/4.4.0/install.sh
```

#### 4.4 安装驱动

驱动安装包位于对应 SDK 版本目录下，路径为 `/mnt/tmpnfs/版本号/corex-installer-linux64-{v.r.m}_x86_64_10.2.run`。

先确认安装包存在：

```bash
ls /mnt/tmpnfs/4.4.0/corex-installer-*.run
```

使用静默安装：

```bash
bash /mnt/tmpnfs/4.4.0/corex-installer-linux64-4.4.0_x86_64_10.2.run --silent --driver --toolkit
```

> 驱动安装耗时较长，通常需要约 5 分钟。安装前先提醒用户等待，执行时注意 SSH 工具的 timeout 参数可能需要调大以避免超时中断。
> SDK 版本和驱动安装包在同一路径下，确保两者版本一致。

#### 4.5 创建软链接与环境变量

```bash
ln -s /usr/local/corex/bin/* /usr/local/bin/
```

环境变量写入 **root** 用户的 bashrc（因为后续 K8s 容器以 root 运行）：

```bash
grep -q 'LD_LIBRARY_PATH.*corex' /root/.bashrc || echo "declare -x LD_LIBRARY_PATH='/usr/local/corex/lib64'" >> /root/.bashrc
```

> 使用 `sudo-exec` 写入 `/root/.bashrc`，而非当前用户的 `~/.bashrc`。先检查是否已存在该条目，避免重复。

验证驱动安装：

```bash
ixsmi
```

### 阶段 5：加入 K8s 集群

使用以下 docker 命令将节点作为 worker 加入集群：

```bash
docker run -d --privileged --restart=unless-stopped --net=host \
  -v /etc/kubernetes:/etc/kubernetes \
  -v /var/run:/var/run \
  registry.iluvatar.com.cn:10443/rancher/rancher-agent:dev \
  --server https://zibo.iluvatar.com \
  --token ppggpzjgllbcn8tpr9w7smkfxhpxwg8dsfgkp5c5vzxvw66d27mll5 \
  --ca-checksum 7b94cca0f678cfe15af27032201a144772f9357be2f3508d07d5fb93fc28fc12 \
  --worker
```

> 这个 token 和 ca-checksum 可能会过期。如果加入失败，提醒用户从 Rancher 控制台获取最新的加入命令。

### 阶段 6：清理

```bash
umount /mnt/tmpnfs
```

## 执行策略

1. **交互确认**：开始前向用户确认目标主机。如果用户指定了多台主机，询问是逐台执行还是并行执行。
2. **阶段汇报**：每个阶段完成后汇报结果，关键命令的输出要展示给用户。
3. **错误处理**：任何命令返回非零退出码，立即停止当前阶段，展示错误信息，等待用户决定（重试 / 跳过 / 终止）。
4. **幂等性**：关键步骤在执行前先检查状态（如 fstab 条目、hosts 条目、bashrc 环境变量），避免重复操作。
5. **超时处理**：驱动安装等耗时操作可能超过默认超时，提醒用户 SSH 工具的 timeout 参数（默认 30s），必要时建议调大。

## 使用示例

用户可能会这样使用：

- "帮我初始化 n110"
- "n205 重装了系统，帮我做一下初始化"
- "新机器 n44 上线，走一遍初始化流程"
- "n110 和 n205 都需要初始化"
- "帮 n110 装一下驱动和加入集群"（部分初始化）

对于部分初始化请求，先展示完整流程，让用户确认需要执行哪些阶段。

## 可选步骤

以下步骤根据实际情况由用户决定是否执行：

- **格式化磁盘**：如果数据盘需要格式化，使用 `mkfs.ext4 /dev/nvme0n1` 或 `mkfs.xfs /dev/nvme0n1`。格式化会清除所有数据，必须用户明确确认后才能执行。
- **Docker 镜像源切换**：如果默认源慢，可切换为国内镜像源。
- **单步执行**：用户可能只想执行某几个阶段，跳过其他。灵活配合。

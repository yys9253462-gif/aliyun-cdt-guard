#!/bin/sh
# ==============================================================================
# 阿里云小磁盘（1G/2G）Alpine 救机 / 全自动装机脚本
# ==============================================================================
# 使用场景：
#   阿里云 ECS 挂载 Alpine 光盘（LiveCD）启动后，VNC 控制台里以 root 登录
#   （默认无密码，直接回车），然后粘贴执行本脚本，即可全自动完成：
#     1. 修复网络（DHCP 获取内网 IP + 配置 DNS）
#     2. 释放磁盘占用（把 LiveCD 内容转存内存）
#     3. 全盘写入 Alpine 系统到硬盘
#     4. 设置 root 密码、开启 SSH 密码登录
#     5. 自动重启进入硬盘系统
#
# 用法：
#   sh alpine-rescue.sh                       # 使用默认密码
#   sh alpine-rescue.sh 你的密码               # 指定 root 密码
# ==============================================================================

set -e

ROOT_PASSWORD="${1:-yiwan123}"
TARGET_DISK="${2:-/dev/vda}"

echo "=============================================="
echo " 阿里云 Alpine 救机脚本"
echo " 目标磁盘：${TARGET_DISK}"
echo " 登录密码：${ROOT_PASSWORD}"
echo "=============================================="

# ---------------- 第 1 步：修复网络 ----------------
echo ""
echo ">> [1/5] 修复网络..."

# 清掉可能存在的错误静态配置（例如被误配成公网 IP）
ip addr flush dev "${IFACE:-eth0}" 2>/dev/null || true

# 用 DHCP 向云平台索取正确的内网 IP、网关与 DNS
# 注意：阿里云 VPC 下网卡必须拿内网 IP，公网 IP 由底层 NAT 映射，不能手工配
udhcpc -i eth0 -q -n 2>/dev/null || true

# 兜底写 DNS（DHCP 没下发时也能解析域名）
if [ ! -s /etc/resolv.conf ]; then
    echo "nameserver 223.5.5.5" > /etc/resolv.conf
    echo "nameserver 8.8.8.8" >> /etc/resolv.conf
fi

if ping -c 2 mirrors.aliyun.com >/dev/null 2>&1; then
    echo "    网络正常（阿里云源可达）"
    MIRROR_OK=cn
elif ping -c 2 dl-cdn.alpinelinux.org >/dev/null 2>&1; then
    echo "    网络正常（海外源可达）"
    MIRROR_OK=intl
else
    echo "    [警告] 网络不通！请检查阿里云安全组与交换机配置。"
    echo "    仍将继续尝试安装，若失败请手动排查网络后重跑本脚本。"
    MIRROR_OK=none
fi

# ---------------- 第 2 步：释放磁盘占用 ----------------
echo ""
echo ">> [2/5] 解除 LiveCD 对磁盘的占用..."

# LiveCD 以只读方式挂在 /media/vda，必须先搬到内存才能格式化该盘
mkdir -p /media/setup
cp -a /media/vda/* /media/setup/ 2>/dev/null || true

# 内核模块目录也需要搬到内存，否则卸载后会丢
mkdir -p /lib/setup
cp -a /.modloop/* /lib/setup/ 2>/dev/null || true

rc-service modloop stop 2>/dev/null || true
umount -l /media/vda 2>/dev/null || true
mv /lib/setup/* /.modloop/ 2>/dev/null || true

if mount | grep -q "on /media/vda"; then
    echo "    [警告] 磁盘仍处于挂载状态，尝试强制卸载..."
    umount -f /media/vda 2>/dev/null || true
fi
echo "    磁盘已释放"

# ---------------- 第 3 步：配置软件源 ----------------
echo ""
echo ">> [3/5] 配置软件源..."

if [ "$MIRROR_OK" = "cn" ]; then
    echo "http://mirrors.aliyun.com/alpine/latest-stable/main" > /etc/apk/repositories
    echo "http://mirrors.aliyun.com/alpine/latest-stable/community" >> /etc/apk/repositories
    echo "    使用阿里云内网高速源"
else
    echo "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main" > /etc/apk/repositories
    echo "https://dl-cdn.alpinelinux.org/alpine/latest-stable/community" >> /etc/apk/repositories
    echo "    使用 Alpine 官方全球源"
fi

apk update >/dev/null 2>&1 || {
    echo "    [错误] 软件源更新失败，请检查网络后重新运行本脚本。"
    exit 1
}

# ---------------- 第 4 步：全盘写入系统 ----------------
echo ""
echo ">> [4/5] 正在格式化磁盘并写入系统（约 3-6 分钟，请勿关闭窗口）..."

# ERASE_DISKS 让脚本不再二次确认，直接清盘
ERASE_DISKS="${TARGET_DISK}" setup-disk -m sys "${TARGET_DISK}"

echo "    系统写入完成"

# ---------------- 第 5 步：配置登录方式 ----------------
echo ""
echo ">> [5/5] 配置远程登录..."

mkdir -p /mnt
ROOT_PART=""
for part in "${TARGET_DISK}3" "${TARGET_DISK}2" "${TARGET_DISK}1"; do
    if mount "$part" /mnt 2>/dev/null; then
        ROOT_PART="$part"
        break
    fi
done

if [ -z "$ROOT_PART" ]; then
    echo "    [错误] 无法挂载新系统分区，请记录此错误并手动检查。"
    exit 1
fi

# 允许 root 用密码登录（默认配置只允许密钥登录）
if [ -f /mnt/etc/ssh/sshd_config ]; then
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /mnt/etc/ssh/sshd_config
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /mnt/etc/ssh/sshd_config
    grep -q '^PermitRootLogin' /mnt/etc/ssh/sshd_config || \
        echo 'PermitRootLogin yes' >> /mnt/etc/ssh/sshd_config
fi

# 设置 root 密码
echo "root:${ROOT_PASSWORD}" | chpasswd -R /mnt 2>/dev/null || \
    echo "root:${ROOT_PASSWORD}" | chpasswd 2>/dev/null || true

# 确保 SSH 与网络服务开机自启
ln -sf /etc/init.d/sshd /mnt/etc/runlevels/default/sshd 2>/dev/null || true
ln -sf /etc/init.d/networking /mnt/etc/runlevels/boot/networking 2>/dev/null || true

# 固化软件源到新系统，避免装完之后无法安装软件
cp /etc/apk/repositories /mnt/etc/apk/repositories 2>/dev/null || true

umount /mnt 2>/dev/null || true

echo ""
echo "=============================================="
echo " 全部完成！"
echo " 登录用户：root"
echo " 登录密码：${ROOT_PASSWORD}"
echo " 系统将在 5 秒后重启并进入硬盘系统。"
echo " 重启后即可用 SSH 连接本机公网 IP。"
echo "=============================================="
sleep 5
reboot

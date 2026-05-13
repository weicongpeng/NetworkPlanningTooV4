"""
硬件指纹获取工具

用于生成基于机器硬件的唯一标识符，用于license绑定
"""

import platform
import hashlib
import subprocess
import re
from typing import Optional


class HardwareFingerprint:
    """硬件指纹类"""

    @staticmethod
    def get_cpu_id() -> str:
        """获取CPU ID"""
        try:
            # Windows系统
            if platform.system() == "Windows":
                result = subprocess.run(
                    ["wmic", "cpu", "get", "ProcessorId"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    lines = result.stdout.strip().split("\n")
                    if len(lines) > 1:
                        return lines[1].strip()

            # Linux系统
            elif platform.system() == "Linux":
                try:
                    with open("/proc/cpuinfo", "r") as f:
                        for line in f:
                            if "serial" in line.lower():
                                return line.split(":")[1].strip()
                except:
                    pass

            # macOS系统
            elif platform.system() == "Darwin":
                result = subprocess.run(
                    ["sysctl", "-n", "machdep.cpu.brand_string"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    return result.stdout.strip()

        except Exception as e:
            print(f"获取CPU ID失败: {e}")

        # 回退方案：使用系统信息生成
        return f"CPU-{platform.machine()}"

    @staticmethod
    def get_mac_address() -> str:
        """获取MAC地址"""
        try:
            import uuid

            mac = uuid.getnode()
            return ":".join(
                ["{:02x}".format((mac >> i) & 0xFF) for i in range(0, 48, 8)][::-1]
            )
        except Exception as e:
            print(f"获取MAC地址失败: {e}")
            return "00:00:00:00:00:00"

    @staticmethod
    def get_disk_id() -> str:
        """获取磁盘ID"""
        try:
            # Windows系统
            if platform.system() == "Windows":
                result = subprocess.run(
                    ["wmic", "diskdrive", "get", "serialnumber"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    lines = result.stdout.strip().split("\n")
                    if len(lines) > 1:
                        return lines[1].strip()

            # Linux系统
            elif platform.system() == "Linux":
                try:
                    with open("/etc/machine-id", "r") as f:
                        return f.read().strip()
                except:
                    try:
                        result = subprocess.run(
                            ["blkid", "-s", "UUID", "-o", "value"],
                            capture_output=True,
                            text=True,
                            timeout=10,
                        )
                        if result.returncode == 0 and result.stdout.strip():
                            return result.stdout.strip().split("\n")[0]
                    except:
                        pass

            # macOS系统
            elif platform.system() == "Darwin":
                result = subprocess.run(
                    ["diskutil", "info", "/"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    match = re.search(r"Volume UUID:\s+(\S+)", result.stdout)
                    if match:
                        return match.group(1)

        except Exception as e:
            print(f"获取磁盘ID失败: {e}")

        # 回退方案：使用主机名
        return f"DISK-{platform.node()}"

    @staticmethod
    def get_system_info() -> dict:
        """获取系统信息"""
        return {
            "system": platform.system(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "node": platform.node(),
        }

    @staticmethod
    def generate_fingerprint() -> str:
        """
        生成硬件指纹

        Returns:
            硬件指纹字符串（SHA256哈希）
        """
        # 收集硬件信息
        cpu_id = HardwareFingerprint.get_cpu_id()
        mac_address = HardwareFingerprint.get_mac_address()
        disk_id = HardwareFingerprint.get_disk_id()
        system_info = HardwareFingerprint.get_system_info()

        # 组合硬件信息
        hardware_info = f"{cpu_id}|{mac_address}|{disk_id}|{system_info['system']}|{system_info['machine']}"

        # 生成SHA256哈希
        fingerprint = hashlib.sha256(hardware_info.encode("utf-8")).hexdigest()

        return fingerprint

    @staticmethod
    def generate_fingerprint_with_fallback() -> tuple[str, dict]:
        """
        生成硬件指纹并提供详细信息

        Returns:
            (fingerprint, details) - 指纹和详细信息
        """
        cpu_id = HardwareFingerprint.get_cpu_id()
        mac_address = HardwareFingerprint.get_mac_address()
        disk_id = HardwareFingerprint.get_disk_id()
        system_info = HardwareFingerprint.get_system_info()

        details = {
            "cpu_id": cpu_id,
            "mac_address": mac_address,
            "disk_id": disk_id,
            "system": system_info,
        }

        fingerprint = HardwareFingerprint.generate_fingerprint()

        return fingerprint, details


# 便捷函数
def get_fingerprint() -> str:
    """获取硬件指纹（便捷函数）"""
    return HardwareFingerprint.generate_fingerprint()


def get_fingerprint_details() -> tuple[str, dict]:
    """获取硬件指纹和详细信息（便捷函数）"""
    return HardwareFingerprint.generate_fingerprint_with_fallback()


if __name__ == "__main__":
    """测试代码"""
    print("=" * 60)
    print("硬件指纹生成工具")
    print("=" * 60)

    fingerprint, details = get_fingerprint_details()

    print(f"\n硬件指纹: {fingerprint}")
    print(f"\n详细信息:")
    print(f"  CPU ID: {details['cpu_id']}")
    print(f"  MAC地址: {details['mac_address']}")
    print(f"  磁盘ID: {details['disk_id']}")
    print(f"  系统信息: {details['system']}")

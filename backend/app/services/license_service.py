"""
许可证管理服务（简化版）

使用Fernet加密和HMAC签名，不依赖硬件指纹
"""

import json
import hashlib
import hmac
import base64
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from cryptography.fernet import Fernet

from app.core.config import settings
from app.models.schemas import LicenseStatus


class LicenseService:
    """许可证服务类（简化版）"""

    def __init__(self):
        self.license_file = settings.LICENSE_DIR / "license.dat"
        self._fernet = self._create_fernet()

    def _create_fernet(self) -> Fernet:
        """创建Fernet加密器"""
        # 使用配置的密钥创建Fernet
        secret_key_bytes = settings.LICENSE_SECRET_KEY.encode()
        # 派生密钥为32字节URL安全的base64编码
        derived_key = base64.urlsafe_b64encode(
            hashlib.sha256(secret_key_bytes).digest()
        )
        return Fernet(derived_key)

    def _encrypt_and_sign(self, license_data: Dict[str, Any]) -> str:
        """加密并签名许可证数据"""
        # 序列化数据
        serialized = json.dumps(
            license_data, separators=(",", ":"), sort_keys=True
        ).encode()

        # 加密数据
        encrypted_data = self._fernet.encrypt(serialized)

        # 创建签名（HMAC-SHA256）
        signature = hmac.new(
            settings.LICENSE_SECRET_KEY.encode(), encrypted_data, hashlib.sha256
        ).hexdigest()

        # 打包为JSON
        license_package = {
            "encrypted_data": base64.b64encode(encrypted_data).decode("utf-8"),
            "signature": signature,
        }

        # Base64编码整个包
        return base64.b64encode(json.dumps(license_package).encode()).decode("utf-8")

    def _decrypt_and_verify(self, license_key: str) -> tuple[Dict[str, Any], str]:
        """
        解密并验证许可证

        Returns:
            (license_data, error_message)
        """
        try:
            # 解码Base64
            package_json = base64.b64decode(license_key).decode()
            license_package = json.loads(package_json)

            # 提取数据
            encrypted_data = base64.b64decode(license_package["encrypted_data"])
            signature = license_package["signature"]

            # 验证签名
            expected_signature = hmac.new(
                settings.LICENSE_SECRET_KEY.encode(), encrypted_data, hashlib.sha256
            ).hexdigest()

            if not hmac.compare_digest(signature, expected_signature):
                return {}, "许可证签名验证失败，文件可能被篡改"

            # 解密数据
            decrypted = self._fernet.decrypt(encrypted_data)
            license_data = json.loads(decrypted.decode())

            return license_data, ""

        except ValueError as e:
            return {}, f"许可证解密失败: {str(e)}"
        except json.JSONDecodeError as e:
            return {}, f"许可证格式错误: {str(e)}"
        except Exception as e:
            return {}, f"许可证验证失败: {str(e)}"

    def _check_time_anomaly(self) -> tuple[bool, str]:
        """
        检查系统时间是否存在异常回退
        
        Returns:
            (is_valid, error_message)
        """
        try:
            time_file = settings.LICENSE_DIR / ".last_time.dat"
            current_time = datetime.now()
            
            if time_file.exists():
                try:
                    with open(time_file, "r") as f:
                        last_time_str = f.read().strip()
                        last_time = datetime.fromisoformat(last_time_str)
                    
                    # 允许 5 分钟的误差（防止系统时钟微调导致的误判）
                    if current_time < last_time - timedelta(minutes=5):
                        return False, "检测到系统时间异常回退，许可证已锁定，请联系管理员"
                except Exception as e:
                    # 如果读取失败，可能文件损坏，为安全起见不报错但记录
                    print(f"读取时间校验文件失败: {e}")
            
            # 更新最后一次检查时间
            settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
            with open(time_file, "w") as f:
                f.write(current_time.isoformat())
                
            return True, ""
        except Exception as e:
            print(f"时间异常检测执行失败: {e}")
            return True, "" # 容错：如果检测逻辑本身出汗，不影响正常授权流程，但生产环境应更严格

    def _validate_license_data(self, license_data: Dict[str, Any]) -> tuple[bool, str]:
        """
        验证许可证数据
 
        Returns:
            (is_valid, error_message)
        """
        try:
            # 1. 检查时间异常（回退检测）
            time_ok, time_error = self._check_time_anomaly()
            if not time_ok:
                return False, time_error

            # 2. 检查必需字段
            required_fields = ["version", "expire_date", "valid", "author"]
            for field in required_fields:
                if field not in license_data:
                    return False, f"许可证缺少必需字段: {field}"
 
            # 3. 检查版本
            if license_data["version"] != "1.0":
                return False, f"不支持的许可证版本: {license_data['version']}"
 
            # 4. 检查有效性标志
            if not license_data["valid"]:
                return False, "许可证已被标记为无效"
 
            # 5. 检查过期日期
            try:
                expire_date = datetime.strptime(license_data["expire_date"], "%Y-%m-%d")
                if expire_date < datetime.now():
                    return (
                        False,
                        f"License已过期，请联系管理员：邮箱：weicongpeng1@163.com；微信：pengwc2010",
                    )
            except ValueError:
                return False, f"无效的过期日期格式: {license_data['expire_date']}"
 
            return True, ""
 
        except Exception as e:
            return False, f"许可证验证失败: {str(e)}"

    def get_status(self) -> LicenseStatus:
        """获取许可证状态"""
        if not self.license_file.exists():
            return LicenseStatus(
                valid=False,
                expiryDate="",
                licensee="",
                licenseKey=None,
                features=None,
                version="",
                errorMessage="未授权，请上传许可证文件",
                remainingDays=0,
            )

        try:
            # 读取许可证文件
            with open(self.license_file, "r", encoding="utf-8") as f:
                license_key = f.read().strip()

            # 解密和验证
            license_data, error_message = self._decrypt_and_verify(license_key)

            if error_message:
                return LicenseStatus(
                    valid=False,
                    expiryDate="",
                    licensee="",
                    licenseKey=license_key[:20] + "...",
                    version="",
                    errorMessage=error_message,
                    remainingDays=0,
                )

            # 验证许可证数据
            is_valid, validate_error = self._validate_license_data(license_data)

            if not is_valid:
                return LicenseStatus(
                    valid=False,
                    expiryDate=license_data.get("expire_date", ""),
                    licensee=license_data.get("author", ""),
                    licenseKey=license_key[:20] + "...",
                    version=license_data.get("version", ""),
                    errorMessage=validate_error,
                    remainingDays=0,
                )

            # 计算剩余天数
            expire_date = datetime.strptime(license_data["expire_date"], "%Y-%m-%d")
            remaining_days = (expire_date - datetime.now()).days

            return LicenseStatus(
                valid=True,
                expiryDate=license_data["expire_date"],
                licensee=license_data.get("author", ""),
                licenseKey=license_key[:20] + "...",
                features=["all"],  # 简化版本，所有功能都可用
                version=license_data.get("version", ""),
                errorMessage=None,
                remainingDays=remaining_days,
            )

        except Exception as e:
            print(f"读取许可证失败: {e}")
            return LicenseStatus(
                valid=False,
                expiryDate="",
                licensee="",
                licenseKey=None,
                version="",
                errorMessage=f"读取许可证失败: {str(e)}",
                remainingDays=0,
            )

    def activate(self, license_key: str) -> tuple[bool, str]:
        """
        激活许可证

        Args:
            license_key: 许可证密钥（Base64编码的完整包）

        Returns:
            (success, message)
        """
        try:
            # 解密和验证
            license_data, error_message = self._decrypt_and_verify(license_key)

            if error_message:
                return False, error_message

            # 验证许可证数据
            is_valid, validate_error = self._validate_license_data(license_data)

            if not is_valid:
                return False, validate_error

            # 保存许可证
            settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
            with open(self.license_file, "w", encoding="utf-8") as f:
                f.write(license_key)

            return True, "许可证激活成功"

        except Exception as e:
            print(f"激活许可证失败: {e}")
            return False, f"激活许可证失败: {str(e)}"

    def upload(self, file_content: bytes) -> tuple[bool, str]:
        """
        上传许可证文件

        Args:
            file_content: 许可证文件内容

        Returns:
            (success, message)
        """
        try:
            # 尝试直接解码为字符串
            try:
                license_key = file_content.decode("utf-8").strip()
            except:
                # 如果解码失败，尝试Base64解码
                try:
                    license_key = base64.b64encode(file_content).decode("utf-8")
                except:
                    return False, "许可证文件格式不支持"

            # 激活许可证
            return self.activate(license_key)

        except Exception as e:
            print(f"上传许可证失败: {e}")
            return False, f"上传许可证失败: {str(e)}"

    def check_permission(self, feature: str = None) -> bool:
        """
        检查是否有权限

        Args:
            feature: 功能名称（简化版不使用）

        Returns:
            是否有权限
        """
        status = self.get_status()
        return status.valid


# 创建全局实例
license_service = LicenseService()

"""
许可证管理服务

授权模型：以管理员用户的 license_expiry 字段为全局授权依据。
旧版 license.dat 文件逻辑保留作为无管理员时的回退方案。
"""

import os
import json
import hashlib
import hmac
import base64
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
from cryptography.fernet import Fernet

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.license_public_key import PUBLIC_KEY_HEX
from app.models.schemas import LicenseStatus
from app.utils.machine_code import get_machine_code, normalize_machine_code


class LicenseService:
    """许可证服务类"""

    def __init__(self):
        self.license_file = settings.LICENSE_DIR / "license.dat"
        self._fernet = self._create_fernet()

    def _get_db(self):
        """创建临时数据库会话"""
        db = SessionLocal()
        try:
            return db
        except:
            db.close()
            raise

    # ---- Admin-based 授权查询 ----

    def get_admin_license_expiry(self) -> Optional[datetime]:
        """查询管理员用户的 license_expiry"""
        from app.models.database import User
        db = self._get_db()
        try:
            admin = db.query(User).filter(User.is_admin == True, User.is_active == True).first()
            if admin is None:
                return None
            expiry = admin.license_expiry
            if expiry and expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            return expiry
        finally:
            db.close()

    def update_admin_license_expiry(self, expiry_date: Optional[str]) -> Optional[dict]:
        """
        管理员更新自身的 license_expiry（即全局授权期限）
        expiry_date: "YYYY-MM-DD" 或 None（无限期）
        返回更新后的 user dict 或 None

        桌面模式：授权期限由厂商签发的授权文件决定，禁止管理员自助修改。
        """
        if settings.NPT_DESKTOP:
            return None

        from app.models.database import User
        from app.services.auth_service import auth_service
        db = self._get_db()
        try:
            admin = db.query(User).filter(User.is_admin == True, User.is_active == True).first()
            if not admin:
                return None
            if expiry_date:
                try:
                    expiry = datetime.strptime(expiry_date, "%Y-%m-%d")
                except ValueError:
                    return None
            else:
                expiry = None
            admin.license_expiry = expiry
            db.commit()
            db.refresh(admin)
            return admin.to_dict()
        finally:
            db.close()

    # ---- LicenseStatus 构建 ----

    def get_status(self) -> LicenseStatus:
        """获取许可证状态。

        桌面模式（NPT_DESKTOP=1）：以厂商签名的授权文件为唯一依据；
        服务器模式：以 admin license_expiry 为准（行为与改造前一致）。
        """
        if settings.NPT_DESKTOP:
            return self._desktop_status()

        from app.models.database import User

        # 1. 尝试从 admin 用户的 license_expiry 获取
        db = self._get_db()
        try:
            admin = db.query(User).filter(User.is_admin == True).first()
            if admin is not None:
                expiry = admin.license_expiry
                if expiry and expiry.tzinfo is None:
                    expiry = expiry.replace(tzinfo=timezone.utc)

                if expiry is None:
                    return LicenseStatus(
                        valid=True,
                        expiryDate="",
                        licensee="管理员授权",
                        licenseKey=None,
                        features=["all"],
                        version="user",
                        errorMessage=None,
                        remainingDays=-1,  # -1 表示无限期
                    )

                now = datetime.now(timezone.utc)
                remaining_days = (expiry - now).days
                if remaining_days < 0:
                    return LicenseStatus(
                        valid=False,
                        expiryDate=expiry.strftime("%Y-%m-%d"),
                        licensee="管理员授权",
                        licenseKey=None,
                        features=None,
                        version="user",
                        errorMessage="授权已过期，请联系管理员",
                        remainingDays=0,
                    )

                return LicenseStatus(
                    valid=True,
                    expiryDate=expiry.strftime("%Y-%m-%d"),
                    licensee="管理员授权",
                    licenseKey=None,
                    features=["all"],
                    version="user",
                    errorMessage=None,
                    remainingDays=remaining_days,
                )
        finally:
            db.close()

        # 2. 无 admin 用户时回退到旧 license 文件逻辑
        return self._get_file_license_status()

    def check_permission(self, feature: str = None) -> bool:
        """检查是否有权限"""
        return self.get_status().valid

    # ---- 桌面离线授权（Ed25519 签名 + 机器码绑定） ----

    def _signed_license_file(self):
        """桌面模式授权文件路径（惰性取 settings，便于测试与安装后迁移）。"""
        return settings.LICENSE_DIR / "license.nptlic"

    def _get_public_key(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        hex_key = (os.environ.get("NPT_LICENSE_PUBLIC_KEY_HEX") or PUBLIC_KEY_HEX or "").strip()
        if not hex_key:
            return None
        try:
            return Ed25519PublicKey.from_public_bytes(bytes.fromhex(hex_key))
        except Exception:
            return None

    @staticmethod
    def _canonical_payload(payload: Dict[str, Any]) -> bytes:
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")

    def _decode_signed_license(self, raw: str):
        """解析并验签授权文件，返回 (payload, error_message)。"""
        try:
            package = json.loads(base64.b64decode(raw.strip()).decode("utf-8"))
            payload = package["payload"]
            signature = base64.b64decode(package["sig"])
            if not isinstance(payload, dict):
                raise ValueError("payload 不是对象")
        except Exception:
            return None, "授权文件格式错误，请确认使用的是厂商签发的 .nptlic 文件"

        public_key = self._get_public_key()
        if public_key is None:
            return None, "本安装包未配置授权公钥，无法校验授权文件（请联系厂商）"
        try:
            public_key.verify(signature, self._canonical_payload(payload))
        except Exception:
            return None, "授权文件签名校验失败，文件可能被篡改或与本产品不匹配"
        return payload, ""

    def _verify_desktop_payload(self, payload: Dict[str, Any]):
        """校验授权内容（版本/机器码/有效期/时间回拨），返回 (ok, error)。"""
        if payload.get("v") != 1:
            return False, f"不支持的授权文件版本: {payload.get('v')}"

        licensed_machine = normalize_machine_code(payload.get("machine_code"))
        if licensed_machine != "*" and licensed_machine != normalize_machine_code(get_machine_code()):
            return False, "授权文件与本机机器码不匹配，请联系厂商重新签发"

        expire_raw = str(payload.get("expire_date") or "")
        try:
            expire = datetime.strptime(expire_raw, "%Y-%m-%d")
        except ValueError:
            return False, f"授权到期日期格式错误: {expire_raw}"
        if expire < datetime.now():
            return False, f"授权已于 {expire_raw} 过期，请联系厂商续期"

        time_ok, time_error = self._check_time_anomaly()
        if not time_ok:
            return False, time_error
        return True, ""

    def _desktop_status(self) -> LicenseStatus:
        path = self._signed_license_file()
        if not path.exists():
            return LicenseStatus(
                valid=False, expiryDate="", licensee="", licenseKey=None, features=None,
                version="desktop",
                errorMessage="未激活：请在「许可证」页导入厂商签发的授权文件（.nptlic）",
                remainingDays=0,
            )
        try:
            raw = path.read_text(encoding="utf-8")
        except Exception as e:
            return LicenseStatus(
                valid=False, expiryDate="", licensee="", licenseKey=None, features=None,
                version="desktop", errorMessage=f"读取授权文件失败: {e}", remainingDays=0,
            )

        payload, error = self._decode_signed_license(raw)
        if error:
            return LicenseStatus(
                valid=False, expiryDate="", licensee="", licenseKey=None, features=None,
                version="desktop", errorMessage=error, remainingDays=0,
            )

        ok, verify_error = self._verify_desktop_payload(payload)
        expire_raw = str(payload.get("expire_date") or "")
        licensee = str(payload.get("licensee") or "")
        remaining_days = 0
        try:
            remaining_days = max(
                0, (datetime.strptime(expire_raw, "%Y-%m-%d") - datetime.now()).days
            )
        except ValueError:
            pass

        return LicenseStatus(
            valid=ok,
            expiryDate=expire_raw,
            licensee=licensee,
            licenseKey=None,
            features=["all"] if ok else None,
            version="desktop",
            errorMessage=None if ok else verify_error,
            remainingDays=remaining_days,
        )

    def _activate_desktop(self, license_key: str):
        payload, error = self._decode_signed_license(license_key)
        if error:
            return False, error
        ok, verify_error = self._verify_desktop_payload(payload)
        if not ok:
            return False, verify_error

        settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
        self._signed_license_file().write_text(license_key.strip(), encoding="utf-8")
        self._mirror_desktop_license_expiry(str(payload.get("expire_date") or ""))
        return True, f"授权文件已导入，有效期至 {payload.get('expire_date', '')}"

    def _mirror_desktop_license_expiry(self, expire_date: Optional[str]) -> None:
        """桌面模式：把授权到期日镜像到所有本地用户。

        前端门禁（licenseStore.setFromUser）基于 user.license_expiry：
        null 会被视为"无限期已授权"，因此未激活/无效时必须写入一个过去日期。
        失败不影响授权本身（授权校验始终以签名文件为准）。
        """
        try:
            from app.models.database import User

            value = datetime.strptime(expire_date, "%Y-%m-%d") if expire_date else None
            db = self._get_db()
            try:
                db.query(User).update({User.license_expiry: value})
                db.commit()
            finally:
                db.close()
        except Exception as e:
            print(f"[License] 镜像授权到期日失败（不影响授权）: {e}")

    def desktop_expiry_datetime(self) -> Optional[datetime]:
        """桌面模式当前授权到期日；未激活/无效时返回过去日期（保证前端门禁拦截）。"""
        if not settings.NPT_DESKTOP:
            return None
        path = self._signed_license_file()
        if path.exists():
            try:
                payload, error = self._decode_signed_license(path.read_text(encoding="utf-8"))
                if not error and payload:
                    ok, _ = self._verify_desktop_payload(payload)
                    if ok:
                        return datetime.strptime(str(payload.get("expire_date")), "%Y-%m-%d")
            except Exception:
                pass
        return datetime(1970, 1, 1)

    def sync_desktop_admin_expiry(self) -> None:
        """桌面模式启动时调用：让所有本地用户的 license_expiry 与授权文件保持一致。"""
        if not settings.NPT_DESKTOP:
            return
        expiry = self.desktop_expiry_datetime()
        self._mirror_desktop_license_expiry(
            expiry.strftime("%Y-%m-%d") if expiry else None
        )

    # ---- 旧 license 文件逻辑（回退方案） ----

    def _create_fernet(self) -> Fernet:
        secret_key_bytes = settings.LICENSE_SECRET_KEY.encode()
        derived_key = base64.urlsafe_b64encode(
            hashlib.sha256(secret_key_bytes).digest()
        )
        return Fernet(derived_key)

    def _get_file_license_status(self) -> LicenseStatus:
        """从旧 license.dat 文件读取状态（回退方案）"""
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
            with open(self.license_file, "r", encoding="utf-8") as f:
                license_key = f.read().strip()

            license_data, error_message = self._decrypt_and_verify(license_key)
            if error_message:
                return LicenseStatus(
                    valid=False, expiryDate="", licensee="",
                    licenseKey=license_key[:20] + "...", version="",
                    errorMessage=error_message, remainingDays=0,
                )

            is_valid, validate_error = self._validate_license_data(license_data)
            if not is_valid:
                return LicenseStatus(
                    valid=False,
                    expiryDate=license_data.get("expire_date", ""),
                    licensee=license_data.get("author", ""),
                    licenseKey=license_key[:20] + "...",
                    version=license_data.get("version", ""),
                    errorMessage=validate_error, remainingDays=0,
                )

            expire_date = datetime.strptime(license_data["expire_date"], "%Y-%m-%d")
            remaining_days = (expire_date - datetime.now()).days

            return LicenseStatus(
                valid=True,
                expiryDate=license_data["expire_date"],
                licensee=license_data.get("author", ""),
                licenseKey=license_key[:20] + "...",
                features=["all"],
                version=license_data.get("version", ""),
                errorMessage=None, remainingDays=remaining_days,
            )
        except Exception as e:
            print(f"读取许可证失败: {e}")
            return LicenseStatus(
                valid=False, expiryDate="", licensee="",
                licenseKey=None, version="",
                errorMessage=f"读取许可证失败: {str(e)}", remainingDays=0,
            )

    def _encrypt_and_sign(self, license_data: Dict[str, Any]) -> str:
        serialized = json.dumps(
            license_data, separators=(",", ":"), sort_keys=True
        ).encode()
        encrypted_data = self._fernet.encrypt(serialized)
        signature = hmac.new(
            settings.LICENSE_SECRET_KEY.encode(), encrypted_data, hashlib.sha256
        ).hexdigest()
        license_package = {
            "encrypted_data": base64.b64encode(encrypted_data).decode("utf-8"),
            "signature": signature,
        }
        return base64.b64encode(json.dumps(license_package).encode()).decode("utf-8")

    def _decrypt_and_verify(self, license_key: str) -> tuple[Dict[str, Any], str]:
        try:
            package_json = base64.b64decode(license_key).decode()
            license_package = json.loads(package_json)
            encrypted_data = base64.b64decode(license_package["encrypted_data"])
            signature = license_package["signature"]
            expected_signature = hmac.new(
                settings.LICENSE_SECRET_KEY.encode(), encrypted_data, hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(signature, expected_signature):
                return {}, "许可证签名验证失败，文件可能被篡改"
            decrypted = self._fernet.decrypt(encrypted_data)
            return json.loads(decrypted.decode()), ""
        except ValueError as e:
            return {}, f"许可证解密失败: {str(e)}"
        except json.JSONDecodeError as e:
            return {}, f"许可证格式错误: {str(e)}"
        except Exception as e:
            return {}, f"许可证验证失败: {str(e)}"

    def _check_time_anomaly(self) -> tuple[bool, str]:
        try:
            time_file = settings.LICENSE_DIR / ".last_time.dat"
            current_time = datetime.now()
            if time_file.exists():
                try:
                    with open(time_file, "r") as f:
                        last_time_str = f.read().strip()
                        last_time = datetime.fromisoformat(last_time_str)
                    if current_time < last_time - timedelta(minutes=5):
                        return False, "检测到系统时间异常回退，许可证已锁定，请联系管理员"
                except Exception as e:
                    print(f"读取时间校验文件失败: {e}")
            settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
            with open(time_file, "w") as f:
                f.write(current_time.isoformat())
            return True, ""
        except Exception as e:
            print(f"时间异常检测执行失败: {e}")
            return True, ""

    def _validate_license_data(self, license_data: Dict[str, Any]) -> tuple[bool, str]:
        try:
            time_ok, time_error = self._check_time_anomaly()
            if not time_ok:
                return False, time_error
            required_fields = ["version", "expire_date", "valid", "author"]
            for field in required_fields:
                if field not in license_data:
                    return False, f"许可证缺少必需字段: {field}"
            if license_data["version"] != "1.0":
                return False, f"不支持的许可证版本: {license_data['version']}"
            if not license_data["valid"]:
                return False, "许可证已被标记为无效"
            try:
                expire_date = datetime.strptime(license_data["expire_date"], "%Y-%m-%d")
                if expire_date < datetime.now():
                    return False, "License已过期，请联系管理员：邮箱：weicongpeng1@163.com；微信：pengwc2010"
            except ValueError:
                return False, f"无效的过期日期格式: {license_data['expire_date']}"
            return True, ""
        except Exception as e:
            return False, f"许可证验证失败: {str(e)}"

    def activate(self, license_key: str) -> tuple[bool, str]:
        if settings.NPT_DESKTOP:
            return self._activate_desktop(license_key)
        try:
            license_data, error_message = self._decrypt_and_verify(license_key)
            if error_message:
                return False, error_message
            is_valid, validate_error = self._validate_license_data(license_data)
            if not is_valid:
                return False, validate_error
            settings.LICENSE_DIR.mkdir(parents=True, exist_ok=True)
            with open(self.license_file, "w", encoding="utf-8") as f:
                f.write(license_key)
            return True, "许可证激活成功"
        except Exception as e:
            print(f"激活许可证失败: {e}")
            return False, f"激活许可证失败: {str(e)}"

    def upload(self, file_content: bytes) -> tuple[bool, str]:
        try:
            try:
                license_key = file_content.decode("utf-8").strip()
            except:
                try:
                    license_key = base64.b64encode(file_content).decode("utf-8")
                except:
                    return False, "许可证文件格式不支持"
            return self.activate(license_key)
        except Exception as e:
            print(f"上传许可证失败: {e}")
            return False, f"上传许可证失败: {str(e)}"


# 创建全局实例
license_service = LicenseService()

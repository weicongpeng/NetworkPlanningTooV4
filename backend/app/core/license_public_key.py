"""离线授权验签公钥（Ed25519）。

厂商侧执行 ``python desktop/tools/gen_keypair.py`` 生成密钥对：
- 私钥保存在厂商手里（desktop/tools/keys/，已在 .gitignore 屏蔽），**绝不入库、不进安装包**
- 公钥（hex）粘贴到本文件后随程序分发；客户端只校验签名，无法签发授权

留空时桌面模式视为未配置授权公钥，将拒绝一切授权文件（不影响服务器部署）。
测试或特殊部署可用环境变量 ``NPT_LICENSE_PUBLIC_KEY_HEX`` 覆盖。
"""

# 形如 "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
PUBLIC_KEY_HEX: str = ""

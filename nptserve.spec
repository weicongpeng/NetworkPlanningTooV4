# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['/tmp/nptserve/entry.py'],
    pathex=['/home/pwc/NetworkPlanningTooV3/backend'],
    binaries=[],
    datas=[('/home/pwc/NetworkPlanningTooV3/frontend/dist-renderer', 'frontend/dist-renderer'), ('/home/pwc/NetworkPlanningTooV3/template', 'template')],
    hiddenimports=['passlib.handlers.bcrypt', 'jose.backends.cryptography_backend', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on'],
    hookspath=['/home/pwc/NetworkPlanningTooV3/desktop/hooks'],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['fiona', 'matplotlib', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'cefpython3', 'IPython', 'notebook', 'pytest', 'tkinter'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='nptserve',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='nptserve',
)

; 网络规划工具 —— Windows 桌面离线版安装脚本（Inno Setup 6）
;
; 构建（在仓库根目录）：
;   1) pyinstaller --noconfirm --clean desktop/desktop.spec
;   2) 下载 WebView2 引导安装器到 desktop/webview2/MicrosoftEdgeWebview2Setup.exe
;   3) ISCC desktop/installer.iss  （可用 /DMyAppVersion=x.y.z 覆盖版本号）
;
; 说明：per-user 安装（无需管理员）；用户数据在 %APPDATA%\NetworkPlanningTool，
;       卸载不删除；运行中的程序通过 AppMutex 检测并提示关闭。

#define MyAppName "网络规划工具"
#define MyAppPublisher "pengwc"
#define MyAppExeName "NPT.exe"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

[Setup]
AppId={{7C4F1E62-9B3A-4D2E-8F51-6A0C2B7D9E44}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\NetworkPlanningTool
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\installer-out
OutputBaseFilename=NetworkPlanningTool-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
; 与 desktop/launcher.py 的单实例互斥体一致：安装时检测到程序在运行会提示关闭
AppMutex=Local\NPTDesktop
SetupMutex=Local\NPTDesktopSetup
CloseApplications=force

[Files]
Source: "..\dist\NetworkPlanningTool\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; WebView2 引导安装器（缺失的机器上静默安装；安装完自动删除）
Source: "webview2\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function IsWebView2Installed(): Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, WebView2ClientKey, 'pv', Version) and (Version <> '')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '')) or
    (RegQueryStringValue(HKCU, WebView2ClientKey, 'pv', Version) and (Version <> ''));
end;

procedure InstallWebView2IfNeeded();
var
  ResultCode: Integer;
  InstallerPath: String;
begin
  if IsWebView2Installed() then
    exit;

  InstallerPath := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  if not FileExists(InstallerPath) then
  begin
    MsgBox('未检测到 Microsoft Edge WebView2 运行时，且安装包内未包含引导安装器。' + #13#10 +
           '请联网后手动安装 WebView2 运行时，否则程序无法启动。', mbError, MB_OK);
    exit;
  end;

  if not Exec(InstallerPath, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    MsgBox('WebView2 运行时自动安装失败（返回码 ' + IntToStr(ResultCode) + '）。' + #13#10 +
           '请联网后手动安装 Microsoft Edge WebView2 运行时。', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    InstallWebView2IfNeeded();
end;

[UninstallDelete]
; 仅清理安装目录内残留；用户数据在 %APPDATA%\NetworkPlanningTool，卸载后保留
Type: filesandordirs; Name: "{app}\_internal\__pycache__"

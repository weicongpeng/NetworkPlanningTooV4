; 网优引擎 —— Windows 桌面离线版安装脚本（Inno Setup 6）
;
; 构建（在仓库根目录）：
;   1) pip install -r backend/requirements.txt -r desktop/requirements-desktop.txt
;   2) python desktop/tools/make_icon.py        （生成 app.ico）
;   3) pyinstaller --noconfirm --clean desktop/desktop.spec
;   4) 下载 WebView2 引导安装器到 desktop/webview2/MicrosoftEdgeWebview2Setup.exe
;      （离线机器用；缺失时安装器仍可编译，仅跳过随包安装）
;   5) ISCC desktop/installer.iss               （可用 /DMyAppVersion=x.y.z 覆盖版本号）
;
; 说明：per-user 安装（无需管理员）；用户数据在 %APPDATA%\NetworkPlanningTool，
;       卸载不删除；运行中的程序通过 AppMutex 检测并提示关闭。

#define MyAppName "网优引擎"
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
OutputBaseFilename=NetOpt Engine_Setup-{#MyAppVersion}
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
; 快捷方式图标：随版本换名（app-{#MyAppVersion}.ico），避开 Windows 图标缓存
; 一直沿用旧图标的问题——换了文件名，资源管理器必然重新读取
Source: "app.ico"; DestDir: "{app}"; DestName: "app-{#MyAppVersion}.ico"; Flags: ignoreversion
; WebView2 引导安装器（缺失的机器上静默安装；安装完自动删除）
Source: "webview2\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[InstallDelete]
; 应用改名前的旧快捷方式（网络规划工具）：不清理的话用户可能点到停留在
; 旧图标上的入口，误以为图标没更新
Type: files; Name: "{userdesktop}\网络规划工具.lnk"
Type: files; Name: "{group}\网络规划工具.lnk"
Type: files; Name: "{group}\卸载 网络规划工具.lnk"
; 上一版本的快捷方式图标（{app} 下随版本累积，安装前清理，随后拷入新版本）
Type: files; Name: "{app}\app-*.ico"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app-{#MyAppVersion}.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app-{#MyAppVersion}.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  SHCNE_ASSOCCHANGED = $08000000;
  SHCNF_IDLIST = $0000;

// 通知资源管理器刷新图标缓存：覆盖安装后快捷方式图标立即更新，
// 否则可能长时间停留在旧图标（Windows 按"图标路径+索引"缓存位图）
procedure SHChangeNotify(wEventId: Integer; uFlags: Cardinal; dwItem1, dwItem2: Cardinal);
  external 'SHChangeNotify@shell32.dll stdcall';

procedure RefreshShellIcons();
begin
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
end;

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

procedure WriteVersionFile();
var
  VersionJson: String;
begin
  // 把安装器版本号写进应用包：OTA 客户端以应用读到的 version.json 判断
  // "更新是否生效"。打包产物里的 version.json 由 CI 生成，若本地构建没
  // 重新生成（或版本没跟上），装完后应用仍报旧版本号，会被误判为"更新
  // 未生效"。安装时按 /DMyAppVersion 统一写入可彻底避免这类不一致。
  // PyInstaller 6.x onedir 的包根是 {app}\_internal；旧布局在 {app}，
  // 两处都写，客户端按布局读哪份都对。
  VersionJson := '{"version":"{#MyAppVersion}","channel":"stable","source":"installer"}';
  SaveStringToFile(ExpandConstant('{app}\_internal\version.json'), VersionJson, False);
  SaveStringToFile(ExpandConstant('{app}\version.json'), VersionJson, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RefreshShellIcons();  // 快捷方式已创建，刷新图标缓存让新图标立即生效
    InstallWebView2IfNeeded();
    WriteVersionFile();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RefreshShellIcons();  // 卸载后快捷方式消失，同样需要刷新缓存
end;

[UninstallDelete]
; 仅清理安装目录内残留；用户数据在 %APPDATA%\NetworkPlanningTool，卸载后保留
Type: filesandordirs; Name: "{app}\_internal\__pycache__"

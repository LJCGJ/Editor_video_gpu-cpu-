; Instalador do SmartRender (versão Electron).
; Antes de compilar, gere o app empacotado em ..\dist\SmartRender-win32-x64 (veja o README).
; Compilar: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\smartrender.iss

#define AppName "SmartRender"
#define AppVersion "0.1.0"
#define AppExe "SmartRender.exe"
#define AppDir "..\dist\SmartRender-win32-x64"

[Setup]
AppId={{6F2B7C1E-4D8A-4E0B-9B57-3C1A2E9F5D44}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Instalador do {#AppName}
; Instala só para o usuário atual: não pede senha de administrador.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir=..\dist
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
{ O SmartRender usa o FFmpeg instalado no computador. Se ele não estiver no PATH,
  avisa no fim da instalação como instalar (o app também avisa ao abrir). }
function FFmpegInstalado: Boolean;
begin
  Result := (FileSearch('ffmpeg.exe', GetEnv('PATH')) <> '') and
            (FileSearch('ffprobe.exe', GetEnv('PATH')) <> '');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not WizardSilent) and (not FFmpegInstalado) then
    MsgBox('O SmartRender precisa do FFmpeg, que não foi encontrado neste computador.' + #13#10 + #13#10 +
           'Para instalar, abra o Terminal (ou PowerShell) e rode:' + #13#10 + #13#10 +
           '    winget install Gyan.FFmpeg' + #13#10 + #13#10 +
           'Depois feche e abra o SmartRender de novo.',
           mbInformation, MB_OK);
end;

; Instalador do SmartRender (versão Electron).
; Antes de compilar, gere o app empacotado em ..\dist\SmartRender-win32-x64 (veja o README).
; Compilar: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\smartrender.iss

#define AppName "SmartRender"
#define AppVersion "0.4.0"
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
; Sugere o disco com mais espaço quando o C: está apertado (veja SugerirPasta) e sempre deixa escolher.
DefaultDirName={code:SugerirPasta}
DisableDirPage=no
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
Name: "portatil"; Description: "Guardar preferências, cache e logs na pasta de instalação (modo portátil: o app não usa o C:)"; GroupDescription: "Onde o SmartRender guarda os dados:"; Flags: unchecked

[UninstallDelete]
; Dados do modo portátil (preferências, cache, logs). Vídeos prontos nunca são apagados.
Type: filesandordirs; Name: "{app}\dados"
Type: files; Name: "{app}\pasta-de-dados.txt"

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  MarcadorDados = 'pasta-de-dados.txt';

{ Espaço livre em MB numa unidade, ou -1 se não der para ler. }
function LivreMB(const Raiz: String): Int64;
var
  Livre, Total: Int64;
begin
  if GetSpaceOnDisk64(Raiz, Livre, Total) then
    Result := Livre div 1048576
  else
    Result := -1;
end;

{ Pasta sugerida: a padrão (no perfil do usuário, no C:), ou X:\SmartRender no disco com mais
  espaço quando o C: tem menos de 10 GB livres. A pessoa sempre pode trocar na tela seguinte. }
function SugerirPasta(Param: String): String;
var
  I: Integer;
  Raiz, Melhor: String;
  Livre, MelhorLivre, LivreC: Int64;
begin
  Result := ExpandConstant('{localappdata}\Programs\{#AppName}');
  LivreC := LivreMB('C:\');
  if (LivreC < 0) or (LivreC >= 10240) then
    Exit;
  Melhor := '';
  MelhorLivre := LivreC;
  for I := Ord('D') to Ord('Z') do
  begin
    Raiz := Chr(I) + ':\';
    if DirExists(Raiz) then
    begin
      Livre := LivreMB(Raiz);
      if Livre > MelhorLivre then
      begin
        MelhorLivre := Livre;
        Melhor := Raiz + '{#AppName}';
      end;
    end;
  end;
  if (Melhor <> '') and (MelhorLivre > 2048) then
    Result := Melhor;
end;

{ Fora do C: (ou se o modo portátil já estava ligado), a opção vem marcada. }
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectTasks then
  begin
    if FileExists(AddBackslash(WizardDirValue) + MarcadorDados) or
       (UpperCase(Copy(WizardDirValue, 1, 2)) <> 'C:') then
      WizardSelectTasks('portatil')
    else
      WizardSelectTasks('!portatil');
  end;
end;

{ O SmartRender usa o FFmpeg do computador ou uma cópia em "<programa>\ffmpeg". Se não houver
  nenhum, avisa no fim da instalação como instalar (o app também avisa ao abrir). }
function FFmpegInstalado: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\ffmpeg\ffmpeg.exe')) or
            ((FileSearch('ffmpeg.exe', GetEnv('PATH')) <> '') and
             (FileSearch('ffprobe.exe', GetEnv('PATH')) <> ''));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    Exit;
  { O arquivo vazio liga o modo portátil: o app guarda tudo em "<programa>\dados". }
  if WizardIsTaskSelected('portatil') then
    SaveStringToFile(ExpandConstant('{app}\' + MarcadorDados), '', False)
  else
    DeleteFile(ExpandConstant('{app}\' + MarcadorDados));
  if (not WizardSilent) and (not FFmpegInstalado) then
    MsgBox('O SmartRender precisa do FFmpeg, que não foi encontrado neste computador.' + #13#10 + #13#10 +
           'Para instalar, abra o Terminal (ou PowerShell) e rode:' + #13#10 + #13#10 +
           '    winget install Gyan.FFmpeg' + #13#10 + #13#10 +
           'Ou copie ffmpeg.exe e ffprobe.exe para "' + ExpandConstant('{app}') + '\ffmpeg".' + #13#10 +
           'Depois feche e abra o SmartRender de novo.',
           mbInformation, MB_OK);
end;

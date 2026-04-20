#define MyAppName "Root Record Weather Manager"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define MyAppVersion AppVersion
#define MyAppPublisher "Root Record"
#define MyAppExeName "RootRecordWeatherManager.exe"
#define MyAppId "{{5F3C4180-5E0A-4E9A-90C0-9159C7AA3B73}"
#define DistDir "..\dist\RootRecordWeatherManager-win32-x64"
#define DefaultDataDir "{localappdata}\RootRecord\Weather Manager"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\RootRecord\Weather Manager
DefaultGroupName={#MyAppName}
OutputDir=.\output
OutputBaseFilename=RootRecordWeatherSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CreateUninstallRegKey=yes
UsePreviousAppDir=yes
DisableDirPage=no
CloseApplications=yes
RestartApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
var
  DataDirPage: TInputDirWizardPage;
  SelectedDataDir: string;

function DefaultDataDir: string;
begin
  Result := ExpandConstant('{#DefaultDataDir}');
end;

function ReadStoredDataDir: string;
var
  installDir: string;
  pointerPath: string;
  fileText: AnsiString;
begin
  Result := '';
  if GetEnv('RR_WEATHER_HOME') <> '' then
    Result := Trim(GetEnv('RR_WEATHER_HOME'));
  if Result <> '' then
    exit;
  if IsUninstaller() then
    installDir := ExpandConstant('{app}')
  else
    installDir := WizardDirValue;
  pointerPath := AddBackslash(installDir) + 'weather-manager-data-path.txt';
  if FileExists(pointerPath) then
    if LoadStringFromFile(pointerPath, fileText) then
      Result := Trim(fileText);
  Result := Trim(Result);
end;

procedure UpdateWelcomeTextForUpgrade();
var
  installedExePath: string;
begin
  installedExePath := AddBackslash(WizardDirValue) + '{#MyAppExeName}';
  if FileExists(installedExePath) then
  begin
    WizardForm.WelcomeLabel2.Caption :=
      'Setup detected an existing Root Record Weather Manager installation and will update it to version {#MyAppVersion}.';
  end;
end;

function IsInstalledAlready: Boolean;
var
  uninstallKey: string;
begin
  uninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1';
  Result :=
    RegKeyExists(HKLM, uninstallKey) or
    RegKeyExists(HKLM64, uninstallKey) or
    RegKeyExists(HKCU, uninstallKey) or
    FileExists(AddBackslash(WizardDirValue) + '{#MyAppExeName}');
end;

procedure ApplyUpgradeUiHints();
begin
  if not IsInstalledAlready() then
    exit;

  WizardForm.WelcomeLabel2.Caption :=
    'Setup detected an existing Root Record Weather Manager installation and will update it to version {#MyAppVersion}.';
  WizardForm.SelectDirLabel.Caption :=
    'Setup will update the existing Root Record Weather Manager installation. You can keep this folder or choose a different destination.';
end;

function GetDataDir(Param: string): string;
begin
  if Trim(SelectedDataDir) = '' then
    SelectedDataDir := DefaultDataDir();
  Result := SelectedDataDir;
end;

procedure InitializeWizard();
var
  initialDataDir: string;
begin
  initialDataDir := ReadStoredDataDir();
  if Trim(initialDataDir) = '' then
    initialDataDir := DefaultDataDir();
  SelectedDataDir := initialDataDir;
  ApplyUpgradeUiHints();

  DataDirPage := CreateInputDirPage(
    wpSelectDir,
    'User Data Directory',
    'Choose where Weather Manager stores local data',
    'This folder stores Weather Manager user data (SQLite database, cached feeds, preferences).' + #13#10 +
    'Use an isolated folder for this product.',
    False,
    ''
  );
  DataDirPage.Add('');
  DataDirPage.Values[0] := initialDataDir;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpWelcome) or (CurPageID = wpSelectDir) then
    ApplyUpgradeUiHints();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DataDirPage.ID then
  begin
    SelectedDataDir := Trim(DataDirPage.Values[0]);
    if SelectedDataDir = '' then
    begin
      MsgBox('Please select a data directory.', mbError, MB_OK);
      Result := False;
      exit;
    end;
    if not DirExists(SelectedDataDir) then
      ForceDirectories(SelectedDataDir);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    SaveStringToFile(ExpandConstant('{app}\weather-manager-data-path.txt'), SelectedDataDir, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  dataDir: string;
  answer: Integer;
begin
  if CurUninstallStep <> usUninstall then
    exit;

  dataDir := ReadStoredDataDir();
  if Trim(dataDir) = '' then
    dataDir := DefaultDataDir();

  if (Trim(dataDir) <> '') and DirExists(dataDir) then
  begin
    answer := MsgBox(
      'Remove Weather Manager user data too?' + #13#10 + #13#10 +
      dataDir + #13#10 + #13#10 +
      'Choose Yes to remove cached/persistent data, or No to keep it for a future reinstall.',
      mbConfirmation,
      MB_YESNO
    );
    if answer = IDYES then
      DelTree(dataDir, True, True, True);
  end;
end;

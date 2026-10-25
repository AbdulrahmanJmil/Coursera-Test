; RoundLedger Windows installer (NSIS 3, per-user, no admin rights).
; Built by scripts/build-installer.js, which passes:
;   /DVERSION=x.y.z /DSTAGE=<staging dir> /DOUTFILE=<exe path>
; The installer copies the unpacked extension to %LOCALAPPDATA%\RoundLedger
; and guides the user through Chrome's "Load unpacked" flow. It does not and
; cannot silently install the extension into Chrome.

Unicode true
SetCompressor /SOLID lzma
CRCCheck force
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!ifndef VERSION
  !error "VERSION not defined"
!endif
!define PRODUCT "RoundLedger"
!define PUBLISHER "RoundLedger"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\RoundLedger"
!define MIN_CHROME "116.0.0.0"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\RoundLedger"
BrandingText "${PRODUCT} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT} setup"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

Var ChromePath

!define MUI_ICON "assets\roundledger.ico"
!define MUI_UNICON "assets\roundledger.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "assets\wizard.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This will copy the ${PRODUCT} Chrome extension to your computer and show you how to add it to Google Chrome.$\r$\n$\r$\nGoogle Chrome 116 or later is required.$\r$\n$\r$\nClick Next to continue."
!define MUI_LICENSEPAGE_TEXT_TOP "Please read this information before installing."
!define MUI_FINISHPAGE_TITLE "Files installed. One more step in Chrome."
!define MUI_FINISHPAGE_TEXT "Chrome requires you to add directly-distributed extensions yourself. The setup guide walks you through it in about a minute."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open the setup guide in Chrome"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenGuide

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "notice.txt"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function FindChrome
  StrCpy $ChromePath ""
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0"
    StrCpy $ChromePath $0
    Return
  ${EndIf}
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0"
    StrCpy $ChromePath $0
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
    StrCpy $ChromePath "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
  ${ElseIf} ${FileExists} "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe"
    StrCpy $ChromePath "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    StrCpy $ChromePath "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT} requires Windows 10 or later."
    Abort
  ${EndIf}
  Call FindChrome
  ${If} $ChromePath == ""
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Google Chrome was not found on this computer.$\r$\n$\r$\n${PRODUCT} is a Chrome extension and needs Chrome ${MIN_CHROME} or later. Open the Chrome download page now?" IDNO +2
      ExecShell "open" "https://www.google.com/chrome/"
    Abort
  ${EndIf}
  ${GetFileVersion} "$ChromePath" $0
  ${If} $0 != ""
    ${VersionCompare} "$0" "${MIN_CHROME}" $1
    ${If} $1 == 2
      MessageBox MB_OK|MB_ICONSTOP "Your Chrome version ($0) is too old. Update Chrome (Menu > Help > About Google Chrome) and run this installer again."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Clean replace so files removed in a new version do not linger. Chrome keeps
  ; the extension's data because the extension ID is pinned by its manifest key.
  RMDir /r "$INSTDIR\extension"
  SetOutPath "$INSTDIR\extension"
  File /r "${STAGE}\extension\*.*"
  SetOutPath "$INSTDIR"
  File "${STAGE}\setup-guide.html"
  File "${STAGE}\SHA256SUMS.txt"
  File "${STAGE}\verify-files.ps1"
  File "${STAGE}\README.txt"
  File "assets\roundledger.ico"

  ; Tell the guide where the extension folder is (JS string, backslashes escaped).
  ${WordReplace} "$INSTDIR\extension" "\" "\\" "+" $R0
  FileOpen $R1 "$INSTDIR\install-info.js" w
  FileWrite $R1 'window.RL_INSTALL = { path: "$R0", version: "${VERSION}" };'
  FileClose $R1

  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\${PRODUCT} setup guide.lnk" "$ChromePath" '"$INSTDIR\setup-guide.html"' "$INSTDIR\roundledger.ico"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Uninstall ${PRODUCT}.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\roundledger.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Function OpenGuide
  Exec '"$ChromePath" "$INSTDIR\setup-guide.html"'
FunctionEnd

Section "Uninstall"
  MessageBox MB_OK|MB_ICONINFORMATION "Also remove ${PRODUCT} from Chrome: open chrome://extensions and click Remove on the ${PRODUCT} card. Windows cannot do this for you."
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\setup-guide.html"
  Delete "$INSTDIR\install-info.js"
  Delete "$INSTDIR\SHA256SUMS.txt"
  Delete "$INSTDIR\verify-files.ps1"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\roundledger.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT} setup guide.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}\Uninstall ${PRODUCT}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT}"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd

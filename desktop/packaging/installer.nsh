; AstroviaBin NSIS additions (included by electron-builder).
; Install/upgrade and uninstall close every process running from the install folder: the tray app and
; the server it started (node.exe, python.exe, hotpants.exe). They are matched by their full path, so
; no other Node or Python program on the PC is touched.
; Uninstall also removes the "Start AstroviaBin when I log in" entry and Electron's caches, and asks
; whether to delete the settings. Databases, backups, photos and FITS are never deleted.

!macro AstroviaBinStopProcesses
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR\'; Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800"`
  Pop $0
!macroend

!macro customCheckAppRunning
  !insertmacro AstroviaBinStopProcesses
!macroend

!macro customUnInstall
  !insertmacro AstroviaBinStopProcesses

  ; Login autostart written by Electron (value name = app name or AppUserModelId).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AstroviaBin"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.kroryan.astroviabin"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "AstroviaBin"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.kroryan.astroviabin"

  ; Electron (Chromium) caches and state in the settings folder.
  StrCpy $1 "$APPDATA\AstroviaBin"
  RMDir /r "$1\Cache"
  RMDir /r "$1\Code Cache"
  RMDir /r "$1\GPUCache"
  RMDir /r "$1\DawnGraphiteCache"
  RMDir /r "$1\DawnWebGPUCache"
  RMDir /r "$1\Crashpad"
  RMDir /r "$1\blob_storage"
  RMDir /r "$1\Local Storage"
  RMDir /r "$1\Session Storage"
  RMDir /r "$1\Shared Dictionary"
  RMDir /r "$1\shared_proto_db"
  RMDir /r "$1\WebStorage"
  RMDir /r "$1\VideoDecodeStats"
  RMDir /r "$1\Network"
  RMDir /r "$1\Partitions"
  RMDir /r "$1\IndexedDB"
  RMDir /r "$1\Service Worker"
  RMDir /r "$1\Dictionaries"
  Delete "$1\Preferences"
  Delete "$1\Local State"
  Delete "$1\Cookies"
  Delete "$1\Cookies-journal"
  Delete "$1\Trust Tokens"
  Delete "$1\Trust Tokens-journal"
  Delete "$1\TransportSecurity"
  Delete "$1\lockfile"

  ; Settings (with the stored password) only when the user asks; never during an upgrade.
  ${ifNot} ${isUpdated}
    IfFileExists "$1\astroviabin-desktop.json" 0 astroviabin_settings_done
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your AstroviaBin settings (server address, storage folders and the saved administrator password)?$\r$\n$\r$\nYour database, backups, photos and FITS files are kept either way." /SD IDNO IDNO astroviabin_settings_done
        Delete "$1\astroviabin-desktop.json"
        Delete "$1\astroviabin-desktop.json.tmp"
        Delete "$1\server.env"
    astroviabin_settings_done:
  ${endIf}
  RMDir "$1"
!macroend

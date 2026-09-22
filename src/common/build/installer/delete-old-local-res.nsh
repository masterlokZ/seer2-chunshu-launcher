; NSIS customRemoveFiles: skip login-data when reinstalling (exclude, no backup)
; login-data stores only Cookies, must survive NSIS uninstall/reinstall
;
; electron-builder auto-includes this file via package.json nsis.include,
; so customRemoveFiles macro is defined BEFORE uninstaller.nsh's
; !ifmacrodef customRemoveFiles check (line 128 of uninstaller.nsh).

!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    ; Full uninstall: user wants clean - remove everything
    RMDir /r $INSTDIR
  ${else}
    ; Update/reinstall: ENUM $INSTDIR, SKIP login-data
    ; Use IfFileExists "\*" to distinguish dir vs file
    FindFirst $0 $1 "$INSTDIR\*"
  loop_remove:
    ${If} $1 != ""
      ${IfNot} $1 == "login-data"
        IfFileExists "$INSTDIR\$1\*" 0 is_file
        ; --- is directory ---
        RMDir /r "$INSTDIR\$1"
        Goto continue_loop
      is_file:
        ; --- is file (exe, dll, json, etc.) ---
        Delete "$INSTDIR\$1"
      continue_loop:
      ${EndIf}
      FindNext $0 $1
      Goto loop_remove
    ${EndIf}
    FindClose $0
  ${endif}
!macroend

!macro customInstall
  Delete "$INSTDIR\local-res\对战版by_春树.swf"
  Delete "$INSTDIR\local-res\对战版by_春树_61.swf"
  FileOpen $0 "$INSTDIR\catalog-navigation-reset.pending" w
  FileWrite $0 "reset-navigation-on-next-launch"
  FileClose $0
  FileOpen $0 "$INSTDIR\skin-assignment-reset.pending" w
  FileWrite $0 "reset-skin-assignments-on-next-launch"
  FileClose $0
!macroend

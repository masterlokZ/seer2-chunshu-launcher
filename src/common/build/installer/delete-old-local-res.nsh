; NSIS customRemoveFiles: skip login-data when reinstalling (exclude, no backup)
; login-data stores only Cookies, must survive NSIS uninstall/reinstall
;
; electron-builder auto-includes this file via package.json nsis.include,
; so customRemoveFiles macro is defined BEFORE uninstaller.nsh's
; !ifmacrodef customRemoveFiles check.

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
      ; FindFirst can return dot entries. Never let them resolve back to
      ; $INSTDIR itself (or its parent), and preserve portable login state.
      StrCmp $1 "." continue_loop
      StrCmp $1 ".." continue_loop
      StrCmp $1 "login-data" continue_loop
      IfFileExists "$INSTDIR\$1\*" 0 is_file
      ; --- is directory ---
      RMDir /r "$INSTDIR\$1"
      Goto continue_loop
    is_file:
      ; --- is file (exe, dll, json, etc.) ---
      Delete "$INSTDIR\$1"
    continue_loop:
      FindNext $0 $1
      Goto loop_remove
    ${EndIf}
    FindClose $0
  ${endif}
!macroend

!macro customInstall
  Delete "$INSTDIR\local-res\对战版by_春树.swf"
  Delete "$INSTDIR\local-res\对战版by_春树_61.swf"
!macroend

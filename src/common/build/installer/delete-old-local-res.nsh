!macro customInstall
  Delete "$INSTDIR\local-res\对战版by_春树.swf"
  Delete "$INSTDIR\local-res\对战版by_春树_61.swf"
  ; Reinstalling intentionally preserves Electron userData.  Drop a one-shot
  ; marker so the first launcher process after this install resets only the
  ; catalogue navigation state, without deleting cached catalogue data or
  ; unrelated launcher settings.
  FileOpen $0 "$INSTDIR\catalog-navigation-reset.pending" w
  FileWrite $0 "reset-navigation-on-next-launch"
  FileClose $0
  ; A reinstall must invalidate only the in-game custom-skin assignment
  ; SharedObjects (skinDefine.sol).  The launcher consumes this marker on its
  ; next start and walks both Pepper and legacy Flash roots; the custom-skins
  ; library/configuration itself is intentionally preserved.
  FileOpen $0 "$INSTDIR\skin-assignment-reset.pending" w
  FileWrite $0 "reset-skin-assignments-on-next-launch"
  FileClose $0
!macroend

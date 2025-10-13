; NSIS installer script for Mozu On-Premise App
; This script checks for required dependencies during installation

!macro customInstall
  ; Check if Java is installed
  ReadRegStr $0 HKLM "SOFTWARE\JavaSoft\Java Runtime Environment" "CurrentVersion"
  StrCmp $0 "" java_not_found java_found
  
  java_not_found:
    MessageBox MB_YESNO "Java Runtime Environment가 설치되지 않았습니다.$\r$\n서버 실행을 위해 Java가 필요합니다.$\r$\n$\r$\n설치를 계속하시겠습니까?" IDYES java_continue IDNO java_abort
    java_abort:
      Abort
    java_continue:
      ; Create a desktop shortcut to Java download
      CreateShortCut "$DESKTOP\Java 다운로드.lnk" "https://adoptium.net" "" "" 0
  
  java_found:
    ; Java is installed, continue
    
  ; Check if Git is installed
  ReadRegStr $1 HKLM "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $1 "" git_not_found git_found
  
  git_not_found:
    MessageBox MB_YESNO "Git이 설치되지 않았습니다.$\r$\n프로젝트 다운로드를 위해 Git이 필요합니다.$\r$\n$\r$\n설치를 계속하시겠습니까?" IDYES git_continue IDNO git_abort
    git_abort:
      Abort
    git_continue:
      ; Create a desktop shortcut to Git download
      CreateShortCut "$DESKTOP\Git 다운로드.lnk" "https://git-scm.com/download/win" "" "" 0
  
  git_found:
    ; Git is installed, continue

!macroend

!macro customUnInstall
  ; Clean up any created shortcuts
  Delete "$DESKTOP\Java 다운로드.lnk"
  Delete "$DESKTOP\Git 다운로드.lnk"
!macroend
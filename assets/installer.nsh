; NSIS installer script for Mozu Stock Environment
; This script automatically installs required dependencies

!macro customInstall
  DetailPrint "Checking and installing required dependencies..."
  
  ; Check if Java is installed
  ReadRegStr $0 HKLM "SOFTWARE\JavaSoft\Java Runtime Environment" "CurrentVersion"
  StrCmp $0 "" java_not_found java_found
  
  java_not_found:
    DetailPrint "Installing Java 17..."
    MessageBox MB_YESNO "Java is required for the server. Install automatically?" IDYES install_java IDNO skip_java
    install_java:
      ; Use winget to install Java
      ExecWait '"cmd" /c "winget install --id Eclipse.Temurin.17.JRE --silent --accept-package-agreements --accept-source-agreements"' $1
      StrCmp $1 "0" java_installed java_failed
      java_failed:
        ; Fallback to chocolatey
        ExecWait '"cmd" /c "choco install openjdk17jre -y"' $2
        StrCmp $2 "0" java_installed java_manual
        java_manual:
          MessageBox MB_OK "Automatic Java installation failed. Please install Java 17 manually from https://adoptium.net"
          Goto skip_java
      java_installed:
        DetailPrint "Java installed successfully"
    skip_java:
  
  java_found:
    DetailPrint "Java is available"
    
  ; Check if Git is installed  
  ReadRegStr $1 HKLM "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $1 "" git_not_found git_found
  
  git_not_found:
    DetailPrint "Installing Git..."
    MessageBox MB_YESNO "Git is required for project downloads. Install automatically?" IDYES install_git IDNO skip_git
    install_git:
      ; Use winget to install Git
      ExecWait '"cmd" /c "winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements"' $3
      StrCmp $3 "0" git_installed git_failed
      git_failed:
        ; Fallback to chocolatey
        ExecWait '"cmd" /c "choco install git -y"' $4
        StrCmp $4 "0" git_installed git_manual
        git_manual:
          MessageBox MB_OK "Automatic Git installation failed. Please install Git manually from https://git-scm.com"
          Goto skip_git
      git_installed:
        DetailPrint "Git installed successfully"
    skip_git:
  
  git_found:
    DetailPrint "Git is available"
    
  ; Check if Gradle is installed
  ExecWait '"cmd" /c "gradle --version"' $5
  StrCmp $5 "0" gradle_found gradle_not_found
  
  gradle_not_found:
    DetailPrint "Installing Gradle..."
    MessageBox MB_YESNO "Gradle is required for building the server. Install automatically?" IDYES install_gradle IDNO skip_gradle
    install_gradle:
      ; Use winget to install Gradle
      ExecWait '"cmd" /c "winget install --id Gradle.Gradle --silent --accept-package-agreements --accept-source-agreements"' $6
      StrCmp $6 "0" gradle_installed gradle_failed
      gradle_failed:
        ; Fallback to chocolatey
        ExecWait '"cmd" /c "choco install gradle -y"' $7
        StrCmp $7 "0" gradle_installed gradle_manual
        gradle_manual:
          MessageBox MB_OK "Automatic Gradle installation failed. The app will use gradlew wrapper instead."
          Goto skip_gradle
      gradle_installed:
        DetailPrint "Gradle installed successfully"
    skip_gradle:
  
  gradle_found:
    DetailPrint "Gradle is available"
    
  DetailPrint "Dependency check completed"

!macroend

!macro customUnInstall
  ; Clean up any created shortcuts
  Delete "$DESKTOP\Java 다운로드.lnk"
  Delete "$DESKTOP\Git 다운로드.lnk"
!macroend
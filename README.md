
# MockStock Launcher (Electron + React + TypeScript)

주요 기능:
- GitHub 서버/프론트 저장소 클론 또는 pull
- 각 프로젝트 의존성 설치 (`npm ci`/`npm install`)
- 서버와 프론트 프로세스 실행/중지
- 진행상태/로그 실시간 표시
- UI는 당근 느낌의 주황 계열

## 사용법 (개발)
```bash
npm install
npm run dev
```
- Vite 개발 서버가 5173 포트에서 실행됩니다.
- TypeScript가 `src/main`을 감시 컴파일합니다.
- Electron이 자동 실행됩니다.

## 빌드/배포
```bash
npm run dist
```
- `vite build` + `tsc` 결과를 바탕으로 electron-builder로 패키징합니다.
- 산출물은 `release/` 폴더에 생성됩니다.

## 설정
앱 UI에서 Git 저장소 URL/브랜치/커맨드를 입력하세요.
- 서버 기본 시작 커맨드: `npm run start`
- 프론트 기본 시작 커맨드: `npm run dev`

## 주의사항
- 시스템에 `git`, `npm`이 설치되어 있어야 합니다.
- Windows에서 프로세스 종료는 best-effort로 처리됩니다.
- 실제 프런트앱이 dev 서버를 띄울 경우, Electron 내부에서 띄운 웹뷰를 연결하도록 저장소의 포트 설정을 참고하세요.

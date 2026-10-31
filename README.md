---
title: workflow-canvas
created: 2026-11-01
updated: 2026-11-01
tags: [domain/인공지능, area/ai에이전트, type/설계, agent/codex-01a192cf-855b-74a1-a995-a16532b61d27]
source: ai
status: active
---

> Orca CLI와 연결하는 로컬 그래프 캔버스다. 워크플로를 편집하고, Orca Run의 Task 의존 관계를 가져와 각 단계의 실제 실행 상태를 관찰한다.

## 기능

- 그래프 편집 — 작업·검토·메모 노드 추가, 드래그, 연결·연결 설명 편집, 삭제, 확대·축소.
- 문서 저장 — JSON 파일로 로컬 저장·불러오기·가져오기·내보내기.
- Orca 연결 — Run 선택, Task와 의존 관계 자동 배치, 개별 노드의 Task 연결.
- 상태 표시 — 대기·실행 중·확인 필요·완료·실패·상태 미확인·미연결 구분, 병렬 작업 동시 표시.
- 조회 장애 — 마지막 완료 표시를 재사용하지 않고 상태 미확인으로 전환.
- 실행 경계 — 워커 실행·중지, 질문 응답, 승인, 의존성 실행은 Orca 코디네이터가 담당한다.
- 설계 경계 — 연결 설명과 검토 노드는 설계 정보이며 실행 조건이나 승인 절차를 강제하지 않는다.
- 호환 범위 — 자체 v1 JSON 형식이며 CC Workflow Studio 파일의 직접 가져오기는 지원하지 않는다.

## 설치와 기동

- 요구 사항 — Node.js 22 이상, npm, 실행 중인 Orca 앱과 버전에 맞는 Orca CLI.
- 설치·빌드·실행:

```sh
npm ci
npm run build
./bin/workflow-canvas
```

- 기본 주소 — `http://127.0.0.1:4318`. Orca 프로젝트의 브라우저 탭에서 연다.
- 개발 — `npm run dev`로 같은 주소에서 개발 서버를 실행한다.
- 포트 변경 — `./bin/workflow-canvas --port 4320`.
- CLI 선택 — `ORCA_CLI_COMMAND` 우선, 개발 환경은 `orca-dev`, Linux 외부 터미널은 `orca-ide`, 그 외는 `orca`.
- 환경 변수 — `WORKFLOW_CANVAS_PORT`, `WORKFLOW_CANVAS_DATA_DIR`, `ORCA_CLI_COMMAND`.
- 저장 위치 — 기본 `<checkout>/.local/workflows/`. 로컬 데이터·캐시·빌드 결과는 git에서 제외한다.
- 저장 데이터 — Task 지침·Run/Task ID가 들어갈 수 있으므로 실제 연결 데이터는 공개 저장소에 추가하지 않는다.

## 사용

1. 노드를 선택해 이름·지침을 편집하고 포트를 연결한다.
2. 왼쪽에서 Orca Run을 선택한다.
3. `Task로 그래프 만들기`로 의존 관계를 가져오거나, 단계 속성에서 기존 노드에 Task를 연결한다.
4. 3초 간격으로 갱신되는 상태를 확인한다.
5. `저장`으로 로컬에 보관한다. 문서 이동 시 JSON 내보내기·가져오기를 사용한다.

## 공개 면

- `bin/workflow-canvas` — 로컬 서버 실행 진입점.
- `exports/workflow.schema.json` — 저장·교환용 JSON Schema. 고유 노드·연결 ID와 참조 무결성도 서버에서 검사한다.
- 저장소 내부 코드 — 외부 도구에서 `src/`·`server/`를 직접 참조하지 않는다.
- 설계와 API — [[40_Tools/workflow-canvas/docs/설계와 연동|설계와 연동]].

## 검증

```sh
npm run check
npm test
npm run build
```

- 테스트 — Task와 터미널 상태 분리, 연결 장애, 재시도 순서, 페이지 조회, 그래프 무결성, 저장, API 출처 제한.
- 비밀 검사 — 커밋 대상만 별도 디렉터리에 복사한 뒤 `gitleaks dir <directory> --redact --no-banner`를 실행한다.

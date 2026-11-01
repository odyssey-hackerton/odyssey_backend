# 무료 API로 유저 플로우 확인

2026-10-31 기준. 실제 외부 모델 호출과 브라우저 전체 구동은 아직 미검증이다.

## 연결한 기능

| 화면 기능 | 처리 방식 | 상태 |
| --- | --- | --- |
| 사진·본문 개인정보 탐지, 위험 설명 | Gemini `gemini-3.8-flash` Interactions API | 코드 연결, 합성 응답 테스트 통과 |
| 영역 가림·블러, 본문 가림·삭제, EXIF 제거 | 서버 Pillow/Python | 실제 픽셀·문자열 테스트 통과 |
| 편집 후 재검증 | 결과 사진·본문을 Gemini로 다시 분석 | 코드 연결, 합성 응답 테스트 통과 |
| 자연스러운 지우기·간판 교체 | 미구현. 현재 사진 remove는 단색 가림 | 생성 API 추가 연결 필요 |
| 결과 전달·공유 | 기존 S3 presigned URL → File → Web Share | 기존 연결 유지, 실기기 재시험 필요 |

무료 Gemini 프로젝트에서 가능한 모델을 기본값으로 정했다. **API 키가 속한 프로젝트에 결제가 연결되어 있으면 유료 과금될 수 있다.** 코드만으로 무료 여부를 판단할 수 없으므로 AI Studio에서 확인하고 워커 전용 키를 넣는다. 무료 한도 초과/오류 시 FAILED로 끝나며 유료 모델 폴백이나 자동 재호출은 없다. 최초 탐지와 편집 후 재검증에 보통 2회 호출한다. 워커 장애에 따른 Redis 재처리는 별개다. S3 등 기존 인프라 비용은 AI 무료 티어와 별개다.

공식 근거: [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing), [Interactions API](https://ai.google.dev/api/interactions-api), [이용 조건](https://ai.google.dev/gemini-api/terms). 무료 입력은 서비스 개선·검토에 사용될 수 있으며 개인정보/기밀정보를 보내면 안 된다. 가짜 전화번호·주소와 직접 만든 테스트 이미지로만 확인한다. `store: false`는 대화 상태 저장을 끄는 옵션이며 무료 서비스의 데이터 이용 정책을 바꾸지 않는다.

생성 편집 후보는 [Cloudflare 인페인팅](https://developers.cloudflare.com/workers-ai/models/stable-diffusion-v1-5-inpainting/)이다. 계정·토큰과 [무료 할당량](https://developers.cloudflare.com/workers-ai/platform/pricing/) 확인이 필요하다. 아직 연결하지 않았다.

## 실행 준비

1. 백엔드와 AI 워커를 이번 수정본으로 함께 실행한다. 기존 워커나 Mock 워커가 같은 Redis consumer group에서 실행 중이면 작업이 다른 버전으로 갈 수 있으므로 테스트 환경의 워커를 하나로 맞춘다.
2. `odyssey_ai/.env.example`을 `.env`로 복사하고 무료 프로젝트의 `GEMINI_API_KEY`, 같은 테스트 서버의 `REDIS_URL`, S3 버킷·리전·워커 IAM 키를 설정한다. 워커 IAM은 백엔드 README의 최신 예시를 따른다. 원본/임시 편집본 읽기·쓰기·버전 삭제 및 결과 쓰기가 필요하다. 키를 채팅/커밋/프론트 환경변수에 넣지 않는다. 기존 `odyssey_backend/litellm/.env`는 자동으로 읽지 않는다.
3. 테스트 백엔드(API·Postgres·Redis)와 S3가 준비된 상태에서 워커를 시작한다. Gemini HTTPS outbound가 허용되어야 한다. 이 경로는 LiteLLM을 거치지 않는다.

```sh
cd odyssey_ai
uv sync --locked
uv run python -m worker.check
uv run python -m worker.main
```

다른 터미널에서 UI 실행:

```sh
cd odyssey_backend/frontend
npm ci
VITE_API_TARGET=https://10.1.1.27 npm run dev
```

위 주소는 기존 테스트 서버다. 로컬 API를 쓰면 `VITE_API_TARGET=http://localhost:8000`으로 바꾼다. 이번 코드가 반영되지 않은 서버에 UI만 연결해도 새 AI 기능이 생기는 것은 아니다.

## 수동 확인 순서

1. 화면 상단 **실제 API** 선택 → 합성 사진 1장+가짜 본문 업로드.
2. 분석 → `AWAITING_USER` → 사진 단서의 박스·설명·등급과 본문 단서 확인.
3. 가림/블러/삭제/그대로 두기를 선택 → 적용·재검증.
4. 탐지 후 원본 삭제와 편집 시 동일 파일 재전송을 확인한다. 최초 분석 스냅샷으로 편집하므로 선택 번호가 다른 영역에 적용되지 않아야 한다. 본문 원문이 Redis에서 만료되면 재업로드 안내가 나와야 한다.
5. 결과 사진과 처리된 본문 확인. `findings`는 **잔여 단서**, `details.processed_findings`는 선택이 반영된 최초 단서다. 그대로 둔 단서를 자동 반복으로 가리지 않는다.
6. 공유 전에 결과 파일이 준비되는지 확인한다. X 테스트는 HTTPS의 iPhone Safari에서 공유 시트로 사진/본문이 글쓰기 화면에 도착하는지 확인하고 직접 게시하지 않는다.

CLI로도 합성 사진+본문 → 사용자 선택 대기 → 추천 보호 적용 → 결과 URL 흐름을 확인할 수 있다. 이 명령은 실제 Gemini와 S3 요청을 발생시킨다.

```sh
cd odyssey_backend
SSL_CERT_FILE=certs/rootCA.pem uv run python scripts/smoke_test.py https://10.1.1.27
```

첫 구동의 범위는 사진 1장+본문이다. 여러 사진의 실제 API 처리, 생성 미리보기·재생성·적용 버전, 추가 자연어 요청은 아직 구현하지 않았다. 사진 편집 시 메타데이터를 제거하며 `remove`는 자연스러운 인페인팅이 아니다. 자동 탐지가 놓치는 정보가 있을 수 있으므로 DONE을 안전 보증으로 표시하지 않는다.

## 자동 검증과 남은 확인

- AI: 합성 Gemini 응답으로 탐지 → 최초 영역 선택 → 실제 이미지/본문 편집 → 잔여 위험 반환, 좌표·응답 오류·429·EXIF 회전·전체 본문 삭제 검사.
- 백엔드: Redis 문자열 복원, 원본 findings 전달, 중복/범위 밖 선택·만료 본문 거절, SSE 스모크 대기 검사.
- 프론트: API/SSE·업로드 테스트와 TypeScript/프로덕션 빌드.
- 미확인: 실제 무료 Gemini 응답 품질·지연·한도, 실제 Redis/S3 종단 흐름, 브라우저 화면, X 공유. 이 작업 환경에서는 Docker 소켓·포트 바인딩·Chrome 실행이 제한되었다.

중지: 터미널에서 실행한 Vite/워커는 각각 `Ctrl+C`. 테스트 컨테이너를 중지할 때는 해당 Compose 프로젝트에서 `docker compose stop`을 사용한다. 데이터 삭제 옵션은 필요 없다.

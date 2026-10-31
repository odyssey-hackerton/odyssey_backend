# odyssey_backend

개인정보 보호 서비스의 API 서버와 일반 서버 인프라입니다. 협업 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

- **FastAPI**: 업로드 수신, 작업 등록, 진행 상황(SSE), 결과 presigned URL 발급
- **PostgreSQL**: 작업·결과 메타데이터
- **Redis**: 작업 큐(`jobs`), 결과 큐(`results`), 진행 상태(`job:{id}`)
- **AWS S3**: 원본·결과 이미지
- **React 프론트** (`frontend/`): 사진·글 업로드, 진행 단계 표시, 처리 전후 비교
- **Nginx**: 프론트 서빙, `/api` 리버스 프록시
- **LiteLLM**: LLM/VLM 프록시·폴백, 관리자 UI, 키별 토큰·비용 관리 ([설정](#litellm-프록시))
- **Mock 워커**: 실제 AI 워커 없이 전체 흐름을 개발·시연하기 위한 가짜 워커

AI 워커와 주고받는 메시지 형식은 [`app/schemas/contract.py`](app/schemas/contract.py)에 있습니다.

## 로컬 개발

백엔드:

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

프론트 (Node.js 20 이상). 화면만 고칠 때는 서버의 API에 붙여서 개발하면 됩니다.

6단계 React 테스트 UI의 데모/API 모드와 실행 절차는 [frontend/README.md](frontend/README.md), 화면별 API 현황과 추가 계획은 [docs/ui-api-plan.md](docs/ui-api-plan.md)를 참고하세요.

```bash
cd frontend
npm install
VITE_API_TARGET=http://10.1.1.27 npm run dev   # 서버 API 사용 (VPN 연결 필요), http://localhost:5173
npm run dev                                     # 로컬 백엔드(localhost:8000) 사용
npm run build                                   # 타입 검사 + 빌드 확인
```

`/api` 요청은 개발 서버가 백엔드로 넘겨 주므로 CORS 설정이 필요 없습니다. 배포 때는 `odyssey-web` 이미지를 빌드하면서 React도 함께 빌드됩니다.

서버와 같은 구성으로 띄워 보려면 이미지를 빌드·푸시한 뒤(아래 2번) 로컬에서도 `.env`와 `litellm/.env`를 채우고 `docker compose --env-file .env --env-file litellm/.env up -d`를 실행하면 됩니다. 전체 흐름 확인에는 별도로 실행한 AI 워커가 필요합니다. 업로드 → 진행 이벤트 → 결과 이미지 → 리포트 확인:

```bash
uv run python scripts/smoke_test.py http://localhost
```

## 서버 배포 (일반 서버)

### 1. AWS 준비 (한 번만)

1. S3 버킷 생성: 리전 `ap-northeast-2`, 퍼블릭 액세스 차단 ON, 기본 암호화 SSE-S3
2. 수명 주기 규칙: 접두사 `originals/`, 생성 후 1일 뒤 만료 삭제 (워커의 즉시 삭제가 누락됐을 때 보조 정리)
3. IAM 사용자 2개를 만들고 각각 아래 정책만 연결한 뒤 액세스 키 발급

API 서버용:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/originals/*" },
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/results/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketVersions"], "Resource": "arn:aws:s3:::odyssey-hackarton-images" },
    { "Effect": "Allow", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"], "Resource": "arn:aws:s3:::odyssey-hackarton-images/originals/*" }
  ]
}
```

GPU 워커용:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"], "Resource": "arn:aws:s3:::odyssey-hackarton-images/originals/*" },
    { "Effect": "Allow", "Action": "s3:ListBucketVersions", "Resource": "arn:aws:s3:::odyssey-hackarton-images" },
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/results/*" }
  ]
}
```

### 2. 이미지 빌드·푸시 (로컬 Mac)

서버는 소스 없이 Docker Hub 이미지만 받아 실행합니다. 이미지는 2개입니다.

- `odyssey-api`: FastAPI (Mock 워커도 같은 이미지)
- `odyssey-web`: Nginx 설정 + 정적 프론트

```bash
docker login
DOCKERHUB_USER=<아이디> ./scripts/build-push.sh   # 태그 = git 커밋 해시, latest도 갱신
```

Apple Silicon Mac에서도 서버용 `linux/amd64`로 빌드됩니다. Docker Hub 저장소를 private으로 두면 서버에서도 `docker login`이 필요합니다.

### 3. 서버 준비 (한 번만)

Docker는 [공식 문서의 Ubuntu apt 저장소 방식](https://docs.docker.com/engine/install/ubuntu/)으로 설치하고, `sudo usermod -aG docker $USER` 후 다시 접속합니다. 서버에는 `docker-compose.yml`, 앱 `.env`, `litellm/config.yaml`, `litellm/.env`가 필요합니다. LiteLLM 환경 파일은 아래 [설정 절차](#litellm-프록시)를 따라 준비합니다.

```bash
# 로컬에서
scp -P <SSH포트> docker-compose.yml .env.example <사용자>@<서버주소>:~/odyssey/

# 서버에서
cd ~/odyssey
cp .env.example .env
hostname -I        # 첫 번째 값 = 사설 IP → REDIS_BIND
vi .env
```

| 항목 | 값 |
| --- | --- |
| `DOCKERHUB_USER` | Docker Hub 아이디 |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | 영문·숫자로 된 긴 비밀번호 |
| `REDIS_BIND` | 이 서버의 사설 IP (GPU 워커가 접속) |
| `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | 버킷 이름, API 서버용 IAM 키 |
| `COMPOSE_PROFILES` | AI 워커가 붙기 전까지 `mock`, 붙으면 줄 삭제 |

### 4. 배포·롤백 (서버)

```bash
cd ~/odyssey
docker compose --env-file .env --env-file litellm/.env pull && docker compose --env-file .env --env-file litellm/.env up -d
curl "http://localhost/api/health?deep=true"   # db, redis, s3 모두 true면 정상
```

롤백은 `.env`의 `IMAGE_TAG`를 이전 태그로 바꾸고 같은 명령을 실행합니다. DB 마이그레이션은 API 컨테이너가 시작할 때 자동으로 적용됩니다.

### 5. GPU 워커 연결 정보

AI 팀에 전달할 값입니다.

- `REDIS_URL=redis://:<REDIS_PASSWORD>@<일반 서버 사설 IP>:6379/0`
- `S3_BUCKET`, `S3_REGION=ap-northeast-2`, GPU 워커용 IAM 키
- 메시지 형식: `app/schemas/contract.py` (jobs → 워커, 워커 → results)

GPU 서버에서 `nc -zv <일반 서버 사설 IP> 6379`로 접속되는지 먼저 확인하세요. 안 되면 NCP ACG에서 GPU 서버 사설 IP만 6379를 허용합니다.

### 자주 쓰는 명령

서버의 `~/odyssey`에서 실행합니다.

```bash
docker compose --env-file .env --env-file litellm/.env ps                   # 컨테이너 상태
docker compose --env-file .env --env-file litellm/.env logs -f api          # API 로그
docker compose --env-file .env --env-file litellm/.env exec postgres psql -U odyssey -d odyssey
```

## LiteLLM 프록시

AI 워커의 텍스트 호출(LLM)은 `워커 → LiteLLM → Codyssey 게이트웨이 → GPT-5.4 mini`, 이미지+텍스트 호출(VLM)은 `워커 → LiteLLM → Gemini 3.8 Flash`로 구성한다. VLM은 추후 GPU 서버에 직접 올린 Qwen으로 교체할 수 있도록 공급자 모델·주소·키를 분리한다. Qwen의 서빙 방식은 미정이며 vLLM을 사용한다고 가정하지 않는다. 모델·프롬프트·에이전트 판단은 AI 팀이 정한다. OCR/NER/OpenCV와 검색·지도 API는 기존 실행 경로를 사용한다.

`docker-compose.yml` 하나로 웹·API·Redis·앱 DB·LiteLLM·LiteLLM DB를 실행한다. LiteLLM 전용 PostgreSQL과 볼륨에 모델 설정, Virtual Key, 사용량을 저장한다. 서비스의 `jobs`/`job_results`나 앞으로 추가할 게시물 DB와 마이그레이션을 공유하지 않는다. 환경 파일은 앱 `.env`와 `litellm/.env`로 분리한다. Compose에 두 파일을 읽히되, API는 앱 `.env`만 받고 LiteLLM 서비스에는 지정한 변수만 전달한다.

### 1. 서버 설정 및 실행

서버에는 다음 파일을 같은 디렉터리 구조로 복사한다.

```text
docker-compose.yml
.env.example
litellm/config.yaml
litellm/.env.example
```

최초 한 번만 환경 파일을 복사하고 값을 채운다. 기존 `litellm/.env`가 있으면 보존한다.

```bash
cp -n litellm/.env.example litellm/.env
chmod 600 litellm/.env
# 별도 비밀값이 필요할 때마다 실행해 DB 비밀번호·관리 키·salt·UI 비밀번호에 각각 사용
openssl rand -hex 32
```

| 설정 | 값 |
| --- | --- |
| `LITELLM_DB_PASSWORD` | 영문·숫자의 긴 비밀번호 |
| `LITELLM_MASTER_KEY` | `sk-` + 별도로 생성한 무작위 문자열. 관리자 전용 |
| `LITELLM_SALT_KEY` | 별도로 생성한 무작위 문자열. 최초 설정 후 유지 |
| `LITELLM_UI_PASSWORD` | 별도로 생성한 관리자 로그인 비밀번호 |
| `LLM_MODEL`, `LLM_API_BASE`, `LLM_API_KEY` | 기본 텍스트 모델·공급자 URL·키 |
| `LLM_FALLBACK_MODEL`, `LLM_FALLBACK_API_BASE`, `LLM_FALLBACK_API_KEY` | 대체 텍스트 모델·공급자 URL·키 |
| `GEMINI_MODEL`, `GEMINI_API_KEY` | `gemini/gemini-3.8-flash`, Google AI Studio API 키 |
| `VLM_MODEL`, `VLM_API_BASE`, `VLM_API_KEY` | 현재 VLM 선택. 기본은 위 Gemini 설정을 참조 |
| `VLM_FALLBACK_MODEL`, `VLM_FALLBACK_API_BASE`, `VLM_FALLBACK_API_KEY` | 대체 이미지 지원 모델·공급자 URL·키 |
| `LITELLM_BIND` | 로컬 점검은 `127.0.0.1`, GPU 워커 연결은 일반 서버 사설 IP |

LLM과 VLM은 호출 용도다. 같은 Gemini 모델을 양쪽에 지정해도 되고, 텍스트 전용 모델과 이미지 지원 모델을 각각 지정해도 된다. VLM의 기본·폴백 모델은 **모두 실제 이미지 입력을 지원해야 한다**. `supports_vision: true`는 기능 표시이며 텍스트 모델에 시각 능력을 추가하지 않는다.

공급자별로 네 모델 슬롯 각각의 `*_MODEL`, `*_API_BASE`, `*_API_KEY`를 다음처럼 채운다. 폴백도 실제 사용 가능한 다른 모델/배포가 필요하다.

| 공급자 | MODEL | API_BASE | API_KEY |
| --- | --- | --- | --- |
| Codyssey (OpenAI 호환 전제) | `openai/<게이트웨이가 제공한 모델 ID>` | 게이트웨이의 API Base URL (보통 `/v1` 포함) | 게이트웨이 키 |
| Gemini 직접 연결 | `gemini/<AI 팀 지정 모델 ID>` | `https://generativelanguage.googleapis.com/v1beta` | Google AI Studio 키 |

Codyssey의 주소·모델 ID·Chat Completions 및 이미지 입력 지원 여부는 운영자에게 확인한다. 모델 ID 앞의 `openai/`는 호환 프로토콜 선택이며 OpenAI 서버로 보내라는 뜻이 아니다. API_BASE에는 `/chat/completions`를 붙이지 않는다. Gemini로 교체할 때는 해당 슬롯의 모델·URL·키 세 값을 함께 바꾸고 LiteLLM을 재생성한다. 워커의 호출 별칭은 유지한다.

`litellm/.env`의 기본 모델 설정은 다음과 같다. `${...}`는 Docker Compose가 환경 파일을 읽을 때 치환한다. 참조할 `GEMINI_*` 값을 `VLM_*`보다 먼저 적고, 기존 파일에는 아래 항목을 중복 없이 추가/갱신한다. 기존 비밀값·DB·salt는 보존한다.

```dotenv
# LLM: Codyssey 경유
LLM_MODEL=openai/gpt-5.4-mini
LLM_API_BASE=<Codyssey의 API Base URL>
LLM_API_KEY=<Codyssey 게이트웨이 키>

# VLM: Gemini 직접 연결
GEMINI_MODEL=gemini/gemini-3.8-flash
GEMINI_API_KEY=<Google AI Studio API 키>
VLM_MODEL=${GEMINI_MODEL}
VLM_API_BASE=https://generativelanguage.googleapis.com/v1beta
VLM_API_KEY=${GEMINI_API_KEY}
```

공식 모델 ID는 [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)의 `gpt-5.4-mini`와 [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)의 `gemini-3.8-flash`다. 이 프로젝트는 LiteLLM에 전달하므로 각각 `openai/`, `gemini/`를 붙인다. Codyssey가 `gpt-5.4-mini`를 제공하는지 확인한다. OpenAI에 직접 연결하는 경우에는 `LLM_API_BASE=https://api.openai.com/v1`과 OpenAI API 키를 사용한다. `LLM_API_KEY`는 항상 해당 URL이 인증하는 키이며, 워커용 LiteLLM Virtual Key와 다르다.

Qwen은 GPU 서버에 배포한다. LiteLLM이 지원하는 이미지 입력 API가 준비되면 `VLM_MODEL`, `VLM_API_BASE`, `VLM_API_KEY` 세 값만 해당 서버 설정으로 교체한다. OpenAI 호환 Chat Completions API를 제공하는 **경우에만** `VLM_MODEL=openai/<서버에서 노출한 Qwen 모델 ID>`, `VLM_API_BASE=http://<GPU 서버 사설 주소>:<포트>/v1`, `VLM_API_KEY=<그 서버의 인증 키>` 형식이다. 특정 서빙 엔진을 요구하지 않는다. 다른 API 방식이면 LiteLLM 공급자와 URL 형식도 그에 맞춰 지정한다. GPU 내부 Python 호출만 있고 API가 없다면 환경변수만으로 연결할 수 없으며 API 또는 별도 연결 코드가 필요하다. 정확한 Qwen 모델 ID·API·포트는 배포 방식이 정해진 뒤 채운다. Gemini 키를 Qwen 서버에 전달하지 않는다.

Qwen 선택은 자동 폴백과 별개다. 기존 `LLM_FALLBACK_*`, `VLM_FALLBACK_*`도 실제 대체 모델로 채워야 Compose가 실행된다. 기본 모델과 같은 모델·같은 서버를 폴백으로 지정하면 장애 대비가 되지 않는다. 같은 Codyssey 게이트웨이의 다른 모델을 써도 게이트웨이 전체 장애에는 대응하지 못한다.

통합 구성의 필수값이 비어 있으면 Compose가 실행을 거부한다. 명령은 백엔드 디렉터리에서 실행하고 두 환경 파일을 모두 지정한다. 실제 비밀값이 출력되지 않도록 설정 검사는 `config --quiet`를 사용한다.

```bash
docker compose --env-file .env --env-file litellm/.env config --quiet
docker compose --env-file .env --env-file litellm/.env pull
docker compose --env-file .env --env-file litellm/.env up -d --wait --wait-timeout 300
docker compose --env-file .env --env-file litellm/.env ps
```

GPU 서버와 관리자 VPN/SSH 경로에서만 TCP 4000 접근을 허용한다. `0.0.0.0` 바인딩이나 공개 Nginx 경로는 사용하지 않는다. HTTP로 연결하는 서버 간 구간은 신뢰할 수 있는 사설망/VPN을 전제로 한다. 공유망을 통과하면 TLS 또는 암호화 터널을 추가한다.

같은 Docker 네트워크의 API 컨테이너에서는 `http://litellm:4000/v1`, 별도 GPU 서버에서는 아래 사설 IP 주소를 사용한다. 이전 별도 스택을 실행한 적이 있다면 먼저 기존 LiteLLM·DB 컨테이너를 중지한다. DB 볼륨 이름은 `odyssey-litellm_litellm-pgdata`로 유지해 기존 데이터를 재사용한다.

### 2. 관리자 UI와 워커 키

`http://<LITELLM_BIND>:4000/ui`에 `LITELLM_UI_USERNAME` / `LITELLM_UI_PASSWORD`로 로그인한다. 원격 관리 시 SSH 터널을 사용할 수 있다.

```bash
# 10.1.1.27은 실제 LITELLM_BIND로 변경. 기본 바인딩이면 127.0.0.1 사용.
ssh -N -L 4000:10.1.1.27:4000 -p <SSH포트> <사용자>@<SSH주소>
# 로컬 브라우저: http://localhost:4000/ui
```

Models에서 `odyssey-llm`, `odyssey-llm-fallback`, `odyssey-vlm`, `odyssey-vlm-fallback`을 확인한다. 실제 모델은 환경변수로 정하므로 같은 이름을 UI에서 중복 등록하지 않는다. 환경값 변경 후 `up -d --force-recreate litellm`으로 반영한다.

일반 호출 오류는 `odyssey-llm → odyssey-llm-fallback`, `odyssey-vlm → odyssey-vlm-fallback`으로 전환한다. 이미지 요청을 텍스트 전용 폴백으로 보내지 않는다. 같은 모델 재시도는 0회, 각 시도 제한은 90초이며 워커 타임아웃은 두 시도를 받을 수 있게 210초 이상으로 둔다. 콘텐츠 정책·컨텍스트 길이 오류용 별도 폴백은 설정하지 않았다.

Virtual Keys에서 워커용 키를 만든다. **Key Type은 LLM API (`llm_api`), 허용 모델은 위 네 별칭**으로 지정한다. 기존 `odyssey-gemini` 키를 이미 발급했다면 허용 모델과 호출 이름을 새 별칭으로 갱신한다. 텍스트 전용 키에는 LLM 기본·폴백 두 개만, 이미지 전용 키에는 VLM 기본·폴백 두 개만 허용할 수 있다. Full Access나 master key를 워커에 전달하지 않는다. 개발용과 시연용 키를 분리하고, 에이전트별 집계가 필요하면 `agent-1`, `agent-2`, `agent-3`, `agent-4`처럼 별도 키 별칭을 부여한다.

신규 키의 초기값은 일일 **5 USD**, **30 RPM**, **30,000 TPM**이다. 실제 계정 한도와 팀 예산에 맞춰 발급 화면에서 조정하고 생성된 키의 값을 확인한다. 이 값은 키별 한도이므로 키 4개가 하나의 5 USD 예산을 공유하는 것은 아니다. 공통 한도가 필요하면 Team 예산도 설정한다. 집계 지연과 진행 중 요청으로 초과분이 발생할 수 있어 공급자 한도도 함께 설정한다.

### 3. AI 팀에 전달할 연결 계약

| 항목 | 전달할 값 |
| --- | --- |
| Base URL | `http://<일반 서버 사설 IP>:4000/v1` |
| API Key | 발급한 워커 Virtual Key |
| 텍스트 Model | `odyssey-llm` |
| 이미지+텍스트 Model | `odyssey-vlm` |
| 호출 방식 | OpenAI 호환 Chat Completions. 멀티모달/JSON 응답 등은 AI 팀의 모델에 맞춰 검증 |

워커 환경변수 이름은 AI 팀과 `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_LLM_MODEL=odyssey-llm`, `LITELLM_VLM_MODEL=odyssey-vlm`으로 맞춘다. 프록시는 메시지 내용으로 LLM/VLM을 자동 분류하지 않는다. 호출자가 용도에 맞는 별칭을 선택한다. 이 문서만으로 기존 워커가 자동 연결되는 것은 아니며, AI 팀의 실제 모델 호출 클라이언트에 위 값을 연결해야 한다. 공급자 키와 master key는 전달하지 않는다.

한 게시물에도 선택적 심층 분석·재편집·재검증 호출이 여러 번 생긴다. 호출한 쪽에서 `job_id`, `run_id`, `stage`, `attempt`와 응답의 `x-litellm-call-id`를 연결해 기록한다. 태그별 대시보드 집계는 라이선스에 따라 제한될 수 있으므로 기본 운영은 모델·Virtual Key별 사용량을 기준으로 한다.

### 4. 연결 및 사용량 확인

설정 자체의 포트 격리·필수값 검사는 Docker daemon과 API 키 없이 실행할 수 있다.

```bash
python3 -m unittest discover -s tests -p 'test_litellm_*.py' -v
```

GPU 서버 또는 SSH 터널에서 health를 확인하고, 인증 없는 모델 목록 요청은 401/403으로 거부되는지 확인한다. 사설 IP 바인딩을 썼으면 아래 주소도 해당 IP로 바꾼다.

```bash
curl --fail http://127.0.0.1:4000/health/readiness
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/v1/models
```

실제 연결은 저장소의 `scripts/check_litellm.py`로 점검한다. 키는 숨겨 입력하고 실행당 유료 호출 1회(실패 시 폴백 포함)가 발생할 수 있다. VLM 점검에는 개인정보 없는 빨간 정사각형 PNG를 보내 색 인식까지 확인한다. 성공하면 호출 ID·실제 응답 모델·입력/출력/합계 토큰만 출력한다. 답이 틀리거나 usage가 빠지면 실패한다. 추론 모델이 출력 토큰을 모두 소진하면 점검도 실패하므로 모델의 추론 예산을 확인한다.

```bash
export LITELLM_BASE_URL=http://127.0.0.1:4000/v1
python3 scripts/check_litellm.py odyssey-llm
python3 scripts/check_litellm.py odyssey-vlm
# 기본·폴백 각각의 연결을 확인한다.
python3 scripts/check_litellm.py odyssey-llm-fallback
python3 scripts/check_litellm.py odyssey-vlm-fallback
```

VLM 요청의 `messages[].content`에는 `text`와 `image_url`을 함께 넣는다. 비공개 S3 이미지는 워커가 읽은 바이트를 `data:image/jpeg;base64,...` 등 실제 MIME 타입으로 인코딩한다. 프록시가 접근할 수 없는 로컬 파일 경로나 인증 없는 비공개 S3 URL은 보내지 않는다. LLM은 텍스트 content를 보낸다.

폴백은 별도 테스트 환경에서 기본 모델만 의도적으로 잘못된 모델 ID로 설정한 뒤 같은 요청을 보내 검증한다. 실제 응답 모델과 관리자 로그에서 대체 모델 호출을 확인하고, 두 모델이 모두 실패하면 성공 처리되지 않는지도 확인한다. 테스트 후 원래 설정으로 복구한다. `mock_testing_fallbacks`는 현재 Proxy 요청에서 무시되므로 사용하지 않는다.

Admin UI의 Usage/Logs에서 해당 키의 요청 수, 입력·출력 토큰과 추정 비용이 반영되는지 확인한다. DB 기록이 비동기라 즉시 나타나지 않을 수 있다. Codyssey가 응답에 usage를 제공해야 토큰을 확인할 수 있다. 게이트웨이 전용 모델 ID의 가격을 LiteLLM이 모르면 비용이 없거나 부정확할 수 있으므로 관리자 모델 설정에 공급자가 알려준 입력/출력 토큰 단가를 등록하고 실제 청구액과 대조한다. 단가 확인 전에는 비용 기반 예산 차단을 신뢰하지 않는다. GPU 로컬 추론 시간, Tavily 및 지도 API 비용은 이 집계에 포함되지 않는다.

프롬프트·응답 본문 저장은 꺼두었다. 사용량 집계에는 본문 저장이 필요 없다. UI에서 설정을 저장하면 일부 항목은 YAML보다 DB 값이 우선하므로 Logs 설정에서 `Store Prompts in Spend Logs`가 꺼져 있는지도 확인한다.

### 5. 업데이트·백업

이미지는 `1.105.7`로 고정했다. 버전 변경 전 전용 DB와 `litellm/.env`를 함께 백업한다. `LITELLM_SALT_KEY`를 바꾸면 저장된 공급자 키를 복호화하지 못할 수 있다. 일반적인 정지는 `stop`을 사용하고, `down -v`는 사용량·키·모델 DB까지 삭제하므로 사용하지 않는다. 스키마 변경이 있는 버전은 이미지 태그만 되돌리는 롤백으로 복구되지 않을 수 있다.

```bash
docker compose --env-file .env --env-file litellm/.env stop litellm litellm-db
```

공식 문서: [Vision 입력](https://docs.litellm.ai/docs/completion/vision), [OpenAI 호환 게이트웨이](https://docs.litellm.ai/docs/providers/openai_compatible), [폴백](https://docs.litellm.ai/docs/proxy/reliability), [Gemini 연결](https://docs.litellm.ai/docs/providers/gemini), [관리자 UI](https://docs.litellm.ai/docs/proxy/ui), [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [사용량 로그](https://docs.litellm.ai/docs/proxy/ui_logs).

## API

자세한 요청·응답 형식과 예시는 Swagger 문서(`http://10.1.1.27/docs`)에 있습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/jobs` | `multipart/form-data`로 `file`(jpg·png·webp, 10MB 이하), `text`(5,000자 이하), 또는 둘 다. `202` + `job_id` |
| `GET` | `/api/jobs/{id}` | 현재 상태 (`QUEUED` `DETECTING` `ANALYZING` `TRANSFORMING` `VERIFYING` `DONE` `FAILED`) |
| `GET` | `/api/jobs/{id}/events` | SSE. 상태가 바뀔 때마다 `progress`, 끝나면 `done` 이벤트 |
| `GET` | `/api/jobs/{id}/result` | 이미지: presigned URL(5분), 글: 가린 글, 사진 + 글: 둘 다. 완료 전이면 `409` |
| `GET` | `/api/jobs/{id}/report` | 위험도 전후, 탐지 항목, 반복 횟수 |
| `GET` | `/api/health` | DB·Redis 확인. `?deep=true`면 S3까지 |

입력 종류(`input_type`)는 보낸 필드로 정해집니다. `file`만 보내면 `image`, `text`만 보내면 `text`, 둘 다 보내면 `image_text`입니다. `image_text`는 사진과 글(예: 게시물 사진과 본문)을 AI가 한 작업에서 함께 분석하고, 결과도 처리된 이미지와 가린 글을 함께 돌려줍니다.

프론트 예시:

```js
const { job_id } = await (await fetch("/api/jobs", { method: "POST", body: formData })).json();
const es = new EventSource(`/api/jobs/${job_id}/events`);
es.addEventListener("progress", (e) => render(JSON.parse(e.data).status));
es.addEventListener("done", async () => {
  es.close();
  const result = await (await fetch(`/api/jobs/${job_id}/result`)).json();
  img.src = result.url;
});
```

## 폴더 구조

```
app/
  api/          라우터 (jobs, health)
  core/         설정(.env), 로깅
  db/           SQLAlchemy 모델, 세션
  queue/        Redis 작업 등록, 결과 소비, 진행 상태
  schemas/      API 응답, 워커 메시지 계약(contract.py)
  services/     업로드 검증
  storage/      S3 클라이언트
migrations/     Alembic (API 컨테이너가 시작할 때 자동 적용)
mock_worker/    개발용 가짜 AI 워커
nginx/          Nginx 설정, odyssey-web 이미지 Dockerfile
frontend/       React(Vite) 프론트. odyssey-web 이미지 빌드 때 함께 빌드
scripts/        이미지 빌드·푸시, 스모크 테스트
```

DB 스키마를 바꿀 때: `app/db/models.py` 수정 → `migrations/versions/`에 다음 번호의 마이그레이션 추가(`0001_create_jobs.py` 참고). 배포 시 API 컨테이너가 자동으로 적용합니다.


## 원본 삭제·편집 재전송 적용

탐지 직후 서버 원본을 삭제한다. 프론트는 원본 File을 메모리에 유지하고,
`POST /api/jobs/{id}/transform`에 multipart `file`과 JSON 배열 문자열 `choices`를 다시 보낸다.
사진은 최초 파일과 SHA-256이 일치해야 한다. 본문만 있는 작업에는 file을 생략한다.
새로고침하면 사진을 다시 선택해야 한다. 탐지 0개인 사진도 결과를 재인코딩해 메타데이터를 제거한다.

```sh
curl -X POST http://localhost/api/jobs/JOB_ID/transform \
  -F file=@original.jpg -F 'choices=[{"idx":0,"action":"mask"}]'
```

적용에는 DB migration `0002`, 큐 계약 v2의 API·워커, 프론트를 함께 갱신해야 한다.
v1 작업/워커와 혼용하지 않는다. 이전 작업에는 파일 해시가 없으므로 다시 업로드한다.
위 IAM 예시의 삭제·버전 조회 권한도 반영해야 하며, 버킷 기본값은 양쪽 모두
`odyssey-hackarton-images`다. 이 변경으로 AWS 설정이나 실제 배포를 실행하지는 않았다.

워커는 탐지 결과/임시 편집본 체크포인트를 먼저 남긴 뒤 원본을 삭제하고,
삭제 완료 전에는 결과를 발행하지 않는다. 실행 ID·잠금·완료 결과 캐시로 중복 처리를 막는다.
삭제 실패는 pending 작업으로 재시도한다. API에서 DB/큐 등록 자체가 실패하면 업로드 삭제를
시도하며, 인프라 장애로 이 삭제까지 실패한 경우 기존 1일 수명 주기에 의존한다.
체크포인트는 기본 24시간 동안 유지한다. 결과 이미지 보관 기간은 별도 설정 대상이다.

Compose는 API의 임시 업로드 파일과 Nginx 업로드 버퍼를 `/tmp` tmpfs에 둔다.
Compose 밖에서 실행할 때는 별도 메모리 임시 디렉터리가 필요하다.
현재 Gemini 호출은 외부 서비스 전송이므로 S3 삭제가 외부 서비스 삭제를 보장하지 않는다.

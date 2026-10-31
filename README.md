# odyssey_backend

개인정보 보호 서비스의 API 서버와 일반 서버 인프라입니다. 협업 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

- **FastAPI**: 업로드 수신, 작업 등록, 진행 상황(SSE), 결과 presigned URL 발급
- **PostgreSQL**: 작업·결과 메타데이터
- **Redis**: 작업 큐(`jobs`), 결과 큐(`results`), 진행 상태(`job:{id}`)
- **AWS S3**: 원본·결과 이미지
- **React 프론트** (`frontend/`): 사진·글 업로드, 진행 단계 표시, 처리 전후 비교
- **Nginx**: 프론트 서빙, `/api` 리버스 프록시
- **Mock 워커**: 실제 AI 워커 없이 전체 흐름을 개발·시연하기 위한 가짜 워커

AI 워커와 주고받는 메시지 형식은 [`app/schemas/contract.py`](app/schemas/contract.py)에 있습니다.

## 로컬 개발

백엔드:

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

프론트 (Node.js 20 이상). 화면만 고칠 때는 서버의 API에 붙여서 개발하면 됩니다.

```bash
cd frontend
npm install
VITE_API_TARGET=http://10.1.1.27 npm run dev   # 서버 API 사용 (VPN 연결 필요), http://localhost:5173
npm run dev                                     # 로컬 백엔드(localhost:8000) 사용
npm run build                                   # 타입 검사 + 빌드 확인
```

`/api` 요청은 개발 서버가 백엔드로 넘겨 주므로 CORS 설정이 필요 없습니다. 배포 때는 `odyssey-web` 이미지를 빌드하면서 React도 함께 빌드됩니다.

서버와 같은 구성으로 띄워 보려면 이미지를 빌드·푸시한 뒤(아래 2번) 로컬에서도 `.env`를 채우고 `docker compose up -d`를 실행하면 됩니다. `COMPOSE_PROFILES=mock`이면 AI 워커 대신 Mock 워커가 돕니다. 전체 흐름(업로드 → 진행 이벤트 → 결과 이미지 → 리포트) 확인:

```bash
uv run python scripts/smoke_test.py http://localhost
```

## 서버 배포 (일반 서버)

### 1. AWS 준비 (한 번만)

1. S3 버킷 생성: 리전 `ap-northeast-2`, 퍼블릭 액세스 차단 ON, 기본 암호화 SSE-S3
2. 수명 주기 규칙: 접두사 `originals/`, 생성 후 1일 뒤 만료 삭제
3. IAM 사용자 2개를 만들고 각각 아래 정책만 연결한 뒤 액세스 키 발급

API 서버용:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/originals/*" },
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/results/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::odyssey-hackarton-images" }
  ]
}
```

GPU 워커용:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::odyssey-hackarton-images/originals/*" },
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

Docker는 [공식 문서의 Ubuntu apt 저장소 방식](https://docs.docker.com/engine/install/ubuntu/)으로 설치하고, `sudo usermod -aG docker $USER` 후 다시 접속합니다. 서버에는 `docker-compose.yml`과 `.env` 두 파일만 있으면 됩니다.

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
docker compose pull && docker compose up -d
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
docker compose ps                   # 컨테이너 상태
docker compose logs -f api          # API 로그
docker compose exec postgres psql -U odyssey -d odyssey
```

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

# odyssey-web: React 프론트를 빌드해서 Nginx 이미지에 담는다.
# 빌드: 레포 루트에서  docker build -f nginx/Dockerfile .

# 1) 프론트 빌드. 결과물(정적 파일)은 CPU 종류와 무관하므로 빌드하는 컴퓨터의 플랫폼에서 바로 실행한다.
#    (Apple Silicon에서 amd64 에뮬레이션으로 npm을 돌리면 매우 느리다)
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2) 서빙
FROM nginx:1.27-alpine
COPY --chmod=644 nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html

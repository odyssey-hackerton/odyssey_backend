# odyssey-web: Nginx 설정 + 정적 프론트를 담은 이미지
# 빌드: 레포 루트에서  docker build -f nginx/Dockerfile .
FROM nginx:1.27-alpine

COPY --chmod=644 nginx/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
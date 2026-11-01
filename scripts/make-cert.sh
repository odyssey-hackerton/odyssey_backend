#!/usr/bin/env bash
# 로컬(Mac)에서 실행: 서버 사설 IP용 HTTPS 인증서를 mkcert로 만든다.
#
# 사용법:
#   ./scripts/make-cert.sh 10.1.1.27          주소가 여러 개면 이어서 적는다
#
# 결과는 certs/ 에 생긴다 (커밋되지 않음).
#   cert.pem, key.pem  서버 ~/odyssey/certs/ 로 복사
#   rootCA.pem         접속할 PC에 설치하는 루트 인증서
# 루트 CA 개인키(rootCA-key.pem)는 `mkcert -CAROOT` 폴더에만 둔다. 서버·팀원에게 보내지 않는다.
set -euo pipefail

: "${1:?서버 사설 IP를 지정하세요 (예: ./scripts/make-cert.sh 10.1.1.27)}"
command -v mkcert >/dev/null || { echo "mkcert가 필요합니다: brew install mkcert" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
mkdir -p certs

mkcert -install   # 이 PC 브라우저가 인증서를 신뢰하도록 루트 CA 설치
mkcert -cert-file certs/cert.pem -key-file certs/key.pem "$@"
cp "$(mkcert -CAROOT)/rootCA.pem" certs/

echo
echo "✔ 인증서 생성 완료: certs/"
echo "  서버로 복사: scp -P <SSH포트> certs/cert.pem certs/key.pem <사용자>@<서버주소>:~/odyssey/certs/"
echo "  다른 PC에는 certs/rootCA.pem 설치 (README의 HTTPS 인증서 절)"

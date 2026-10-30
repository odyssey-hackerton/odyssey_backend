// 워커가 보내는 값을 화면용 말로 바꾼다. 모르는 값은 그대로 보여 준다
// (AI 쪽이 새 유형을 추가해도 화면이 깨지지 않게).

const TYPES: Record<string, string> = {
  address: "주소",
  phone_number: "전화번호",
  email: "이메일",
  name: "이름",
  rrn: "주민등록번호",
  card_number: "카드번호",
  tracking_number: "송장번호",
  license_plate: "차량 번호판",
  school_sign: "학교 표지판",
  landmark: "건물·랜드마크",
  face: "얼굴",
  gps: "촬영 위치(GPS)",
  datetime: "촬영 시각",
  device: "촬영 기기",
};

const SOURCES: Record<string, string> = {
  ocr: "사진 속 글자",
  exif: "사진 파일 정보",
  text: "입력한 글",
  object: "사물 인식",
  vlm: "장면 분석",
};

const ACTIONS: Record<string, string> = {
  blur: "흐리게 처리",
  mask: "가림",
  remove: "삭제",
  inpaint: "지움",
};

export const typeLabel = (v: string) => TYPES[v] ?? v;
export const sourceLabel = (v?: string) => (v ? (SOURCES[v] ?? v) : null);
export const actionLabel = (v?: string) => (v ? (ACTIONS[v] ?? v) : null);

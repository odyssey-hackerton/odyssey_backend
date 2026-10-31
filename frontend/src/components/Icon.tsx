import type { CSSProperties } from "react";

const paths = {
  shield: "M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Zm-4 9 3 3 5-6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  image: "M20 13v7H4V4h10M4 16l5-5 6 6m-1-2 3-3 3 3M19 2v6m-3-3h6M8 7h.01",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  check: "m5 12 4 4L19 6",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4",
  copy: "M9 9h12v12H9zM15 5V3H3v12h2",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 4v16M4 12h16",
  edit: "m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
  eye: "m3 3 18 18M10 5a12 12 0 0 1 12 7c-1 2-2 3-4 4M6 6a15 15 0 0 0-4 6c4 7 11 8 16 5M10 10a3 3 0 0 0 4 4",
  erase: "m15 3 7 7-11 11H7l-5-5L15 3Zm-9 9 7 7m-2 2h11",
  crop: "M6 2v16h16M2 6h16v16",
  refresh: "M20 8a9 9 0 1 0 1 7M20 3v6h-6",
  info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4m-4 5v2",
  spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z",
  back: "M20 12H4m6-6-6 6 6 6",
  undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4",
  chevron: "m9 5 7 7-7 7",
} as const;

export type IconName = keyof typeof paths;
export default function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}

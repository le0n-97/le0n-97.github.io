// These constants are replaced only by the standalone GitHub Pages build.
// The existing Sites build keeps its same-origin API and public asset paths.
declare const __SQUARES_PAGES_API_ORIGIN__: string | undefined;
declare const __SQUARES_PUBLIC_BASE__: string | undefined;

const apiOrigin = typeof __SQUARES_PAGES_API_ORIGIN__ === "string"
  ? __SQUARES_PAGES_API_ORIGIN__
  : "";
const publicBase = typeof __SQUARES_PUBLIC_BASE__ === "string"
  ? __SQUARES_PUBLIC_BASE__
  : "/";

export function apiUrl(path: string): string {
  return `${apiOrigin}${path}`;
}

export function publicAsset(path: string): string {
  return `${publicBase}${path.replace(/^\/+/, "")}`;
}

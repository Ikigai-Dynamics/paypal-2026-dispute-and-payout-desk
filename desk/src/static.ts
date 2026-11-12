// the only image paths the server hands out from public/: /img/<name>.png and the favicon set
const ASSET =
  /^\/(img\/[a-z0-9-]+\.png|favicon\.ico|favicon-(16|32)\.png|apple-touch-icon\.png|icon-(192|512)\.png)$/;

/** The file under public/ for an image path, or null when the path is not one we serve. */
export function staticAsset(pathname: string): string | null {
  return ASSET.test(pathname) ? pathname.slice(1) : null;
}

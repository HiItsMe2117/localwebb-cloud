export function getFileUrl(filename: string, page?: number | string): string {
  const encoded = encodeURIComponent(filename);
  let url = `/api/files/${encoded}`;
  if (page != null) url += `?page=${page}`;
  return url;
}

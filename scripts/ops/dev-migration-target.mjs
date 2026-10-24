export function devMigrationUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('DEV migration URL missing or invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' || (url.port && url.port !== '5432') ||
      url.pathname !== '/kalend_dev' || url.username !== 'kalend_dev_migrator' ||
      !url.password || url.hash || [...url.searchParams].some(([k, v]) => k !== 'schema' || v !== 'public')) {
    throw new Error('DEV migration requires kalend_dev_migrator at 127.0.0.1:5432/kalend_dev');
  }
  return value;
}

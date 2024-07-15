export function getFileExtension(base64) {
  const metaData = base64.split(',')[0];
  const fileType = metaData.split(':')[1].split(';')[0];
  const extension = fileType.split('/')[1];
  return extension;
}
